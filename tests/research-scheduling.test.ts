import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ResearchQueue } from '../src/research/queue.js';
import { loadAsyncResearchConfig } from '../src/research/config.js';
import { researchBatchHash } from '../src/knowledge/advice-validator.js';
import { researchFixture } from './helpers/research-fixture.js';
import type { ResearchBatchV2 } from '../src/research/contracts.js';
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
function batch(n: number, scope = 'opponent-a', trigger = false): ResearchBatchV2 {
  const b = {
    ...researchFixture().batch,
    taskType: 'opponent_brief' as const,
    scopeKey: scope,
    cutoff: at(n),
    eligibleHandIds: Array.from({ length: n }, (_, i) => `h${i + 1}`),
    evidenceEventWatermark: n,
    ...(trigger
      ? {
          triggers: [
            {
              kind: 'large_investment' as const,
              handId: `h${n}`,
              decisionId: `d${n}`,
              eventId: n,
              availableAt: at(n),
            },
          ],
        }
      : {}),
  };
  b.sourceSnapshotHash = researchBatchHash(b);
  return b;
}
function queue(path = ':memory:') {
  const q = new ResearchQueue(path);
  cleanup.push(() => q.close());
  return q;
}
function complete(q: ResearchQueue, b: ResearchBatchV2, outcome: unknown = {}) {
  q.enqueue(b, 'model', 8, at(0));
  const job = q.claim('test', 120000)!;
  expect(q.finish(job, 'completed', outcome)).toBe(true);
}
describe('research 1.4 scheduling', () => {
  it('defaults to first 10, refresh 10, global 25, 15 seconds and preserves three retries', () => {
    const config = loadAsyncResearchConfig({}, '/tmp/raw');
    expect(config).toMatchObject({
      initialMinHands: 10,
      minNewHands: 10,
      leakMinNewHands: 25,
      intervalMs: 15000,
      maxRetries: 3,
    });
    expect(
      loadAsyncResearchConfig({ LLM_RESEARCH_MIN_NEW_HANDS: '3' }, '/tmp/raw').initialMinHands,
    ).toBe(3);
    expect(
      loadAsyncResearchConfig({ LLM_RESEARCH_INITIAL_HANDS: '8' }, '/tmp/raw').initialMinHands,
    ).toBe(8);
  });
  it('requires first and refresh samples independently and reports unchanged insufficient evidence', () => {
    const q = queue();
    expect(q.scheduler.evaluate(batch(9), 10, 10).eligible).toBe(false);
    expect(q.scheduler.evaluate(batch(10), 10, 10).eligible).toBe(true);
    complete(q, batch(10), { insufficient: true });
    const unchanged = q.scheduler.evaluate(batch(10), 10, 10);
    expect(unchanged).toMatchObject({
      eligible: false,
      entry: { stage: 'refresh', newHands: 0, reason: 'insufficient_waiting_new_evidence' },
    });
    q.scheduler.save(unchanged.entry);
    expect(q.status().schedules?.[0]).toMatchObject({
      lastOutcome: 'insufficient',
      state: 'waiting',
    });
    expect(q.scheduler.evaluate(batch(19), 10).eligible).toBe(false);
    expect(q.scheduler.evaluate(batch(20), 10).eligible).toBe(true);
  });
  it('triggers an early scoped review once and rejects future/retrograde evidence', () => {
    const q = queue();
    const early = batch(2, 'opponent-a', true);
    expect(q.scheduler.evaluate(early, 10)).toMatchObject({
      eligible: true,
      priority: 1,
      entry: { triggerKind: 'large_investment' },
    });
    complete(q, early);
    const updated = { ...batch(3), triggers: early.triggers };
    expect(q.scheduler.evaluate(updated, 10).eligible).toBe(false);
    expect(q.scheduler.evaluate(batch(4, 'opponent-a', true), 10).eligible).toBe(true);
    const future = batch(1, 'opponent-b', true);
    future.triggers![0]!.availableAt = at(2);
    expect(q.scheduler.evaluate(future, 10).eligible).toBe(false);
    expect(q.scheduler.evaluate(batch(1, 'opponent-a', true), 10).eligible).toBe(false);
  });
  it('does not charge again when a previously consumed source event gains decision attribution', () => {
    const q = queue();
    const first = batch(2, 'opponent-a', true);
    delete first.triggers![0]!.decisionId;
    first.sourceSnapshotHash = researchBatchHash(first);
    complete(q, first);
    // An intervening window no longer contains the original hand.
    const intervening = { ...batch(4), eligibleHandIds: ['h3', 'h4'] };
    intervening.sourceSnapshotHash = researchBatchHash(intervening);
    complete(q, intervening);
    const enriched = {
      ...batch(5),
      eligibleHandIds: ['h2', 'h3', 'h4', 'h5'],
      triggers: [{ ...first.triggers![0]!, decisionId: 'd2' }],
    };
    enriched.sourceSnapshotHash = researchBatchHash(enriched);
    expect(q.scheduler.evaluate(enriched, 10)).toMatchObject({ eligible: false, priority: 0 });
  });
  it('does not replay legacy settled triggers on upgrade or retry failed identical evidence', () => {
    const q = queue();
    const legacy = batch(10);
    complete(q, legacy);
    expect(
      q.scheduler.evaluate({ ...batch(11), triggers: batch(10, 'opponent-a', true).triggers }, 10)
        .eligible,
    ).toBe(false);
    q.enqueue(batch(2, 'opponent-b', true), 'model');
    const job = q.claim('test', 120000)!;
    q.finish(job, 'failed', {}, 'research_failed');
    expect(q.scheduler.evaluate(batch(3, 'opponent-b'), 10)).toMatchObject({
      eligible: false,
      entry: { reason: 'failed_waiting_new_evidence' },
    });
  });
  it('coalesces pending evidence without resetting its age and bounds salient priority by fair aging', () => {
    const q = queue();
    q.enqueue(batch(10, 'a'), 'model', 8, at(0));
    q.enqueue(batch(10, 'b'), 'model', 8, at(1));
    expect(q.scheduler.evaluate(batch(11, 'a'), 10).eligible).toBe(true);
    q.enqueue(batch(11, 'a'), 'model', 8, at(120));
    q.enqueue(batch(10, 'salient', true), 'model', 8, at(121), 1);
    const first = q.claim('test', 120000)!;
    expect(first.batch.scopeKey).toBe('a');
    q.finish(first, 'completed', {});
    const second = q.claim('test', 120000)!;
    expect(second.batch.scopeKey).toBe('b');
    q.finish(second, 'completed', {});
    expect(q.claim('test', 120000)!.batch.scopeKey).toBe('salient');
  });
  it('executes a pending salient case before a replacement that drops its trigger or decision evidence', () => {
    const q = queue();
    const first = batch(2, 'opponent-a', true);
    first.examples = [
      {
        id: 'decision-d2',
        handId: 'h2',
        eventId: 1,
        availableAt: at(1),
        phase: 'decision_visible',
        summary: 'Accepted large investment.',
      },
      {
        id: 'settlement-2',
        handId: 'h2',
        eventId: 2,
        availableAt: at(2),
        phase: 'post_settlement',
        summary: 'Settled result.',
      },
    ];
    first.sourceSnapshotHash = researchBatchHash(first);
    const firstId = q.enqueue(first, 'model', 8, at(0), 1)!;
    const later = batch(5, 'opponent-a', true);
    expect(q.scheduler.evaluate(later, 10).eligible).toBe(true);
    expect(q.enqueue(later, 'model', 8, at(30), 1)).toBeNull();
    const missingDecision = {
      ...later,
      triggers: [...first.triggers!, ...later.triggers!],
      examples: first.examples.filter((e) => e.phase === 'post_settlement'),
    };
    missingDecision.sourceSnapshotHash = researchBatchHash(missingDecision);
    expect(q.enqueue(missingDecision, 'model', 8, at(31), 1)).toBeNull();
    const old = q.claim('test', 120000)!;
    expect(old.id).toBe(firstId);
    expect(old.batch.examples.map((e) => e.id)).toContain('decision-d2');
    q.finish(old, 'completed', {});
    expect(q.scheduler.evaluate(later, 10).eligible).toBe(true);
    expect(q.enqueue(later, 'model', 8, at(32), 1)).not.toBeNull();
    expect(q.status().superseded).toBe(0);
  });
  it('bounds public schedules at 64 while keeping active and global scopes without deleting history', () => {
    const q = queue();
    for (let i = 0; i < 80; i++)
      q.scheduler.save(q.scheduler.evaluate(batch(1, `scope-${i}`), 10, 10, at(i)).entry);
    const global = { ...batch(1, 'global'), taskType: 'leak_review' as const };
    q.scheduler.save(q.scheduler.evaluate(global, 25, 25, at(0)).entry);
    q.enqueue(batch(1, 'scope-0'), 'model');
    const visible = q.status().schedules!;
    expect(visible).toHaveLength(64);
    expect(visible.map((s) => s.scopeKey)).toContain('global');
    expect(visible[0]?.scopeKey).toBe('global');
    expect(visible[1]).toMatchObject({ scopeKey: 'scope-0', state: 'pending' });
    expect(visible.map((s) => s.scopeKey)).toContain('scope-79');
    expect(q.db.prepare('SELECT COUNT(*) AS n FROM research_schedules').get()?.n).toBe(81);
  });
  it('prioritizes new salient events ahead of peers with a similar queue age', () => {
    const q = queue();
    q.enqueue(batch(10, 'ordinary'), 'model', 8, at(0));
    q.enqueue(batch(2, 'salient', true), 'model', 8, at(1), 1);
    expect(q.claim('test', 120000)!.batch.scopeKey).toBe('salient');
  });
  it('migrates legacy derived databases without changing frozen jobs and keeps schedule state across readers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'research-schedule-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'derived.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE research_jobs (id TEXT PRIMARY KEY,task_type TEXT NOT NULL,scope_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,batch TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,
      owner TEXT,lease_until INTEGER,deadline_at INTEGER,created_at TEXT NOT NULL,completed_at TEXT,error TEXT,outcome TEXT,delivered INTEGER NOT NULL DEFAULT 0);`);
    const frozen = JSON.stringify(batch(10));
    old
      .prepare(
        `INSERT INTO research_jobs(id,task_type,scope_key,fingerprint,batch,state,created_at) VALUES('legacy','opponent_brief','opponent-a','fingerprint',?,'pending',?)`,
      )
      .run(frozen, at(0));
    old.close();
    const q = queue(path);
    q.scheduler.save(q.scheduler.evaluate(batch(10), 10).entry);
    const reader = queue(path);
    expect(reader.status().schedules?.[0]).toMatchObject({
      scopeKey: 'opponent-a',
      state: 'pending',
    });
    expect(
      reader.db.prepare("SELECT batch FROM research_jobs WHERE id='legacy'").get()?.batch,
    ).toBe(frozen);
    expect(reader.claim('test', 120000)!.id).toBe('legacy');
    expect(q.status().schedules?.[0]?.state).toBe('running');
  });
});
