import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactsStore, emptyFactsSnapshot, factsHash } from '../src/facts/store.js';
import { FactsWorker } from '../src/facts/worker.js';
import { FactsService } from '../src/facts/service.js';
import { syncOpponentMemory } from '../src/storage/opponent-memory.js';
import type { KnowledgeSnapshot } from '../src/knowledge/types.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'poker-facts-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const rawPath = join(dir, 'raw.sqlite'),
    derivedPath = join(dir, 'facts.sqlite');
  const raw = new DatabaseSync(rawPath);
  cleanup.push(() => raw.close());
  raw.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE events(id INTEGER PRIMARY KEY,run_id TEXT,hand_id TEXT,table_id TEXT,received_at TEXT,type TEXT,payload TEXT);
    CREATE TABLE decisions(id TEXT PRIMARY KEY,context TEXT,proposal TEXT);`);
  function addHand(index: number, received = '2026-01-01T00:00:00.000Z', completed = received) {
    const emit = (type: string, payload: unknown) =>
      raw
        .prepare(
          'INSERT INTO events(run_id,hand_id,table_id,received_at,type,payload) VALUES(?,?,?,?,?,?)',
        )
        .run('run', `hand-${index}`, 'table', received, type, JSON.stringify(payload));
    emit('table_state', {
      ts: completed,
      hero: { seat: 0 },
      board: ['Ac', 'Kd', '8h'],
      seats: [
        { seat: 0, name: 'hero' },
        { seat: 1, name: 'villain' },
      ],
    });
    emit('player_action', {
      ts: completed,
      seat: 1,
      action: 'raise',
      pot_before: 40,
      contribution_delta: 20,
      to_call_before: 0,
    });
    emit('hand_result', {
      ts: completed,
      actions: [{ seat: 1, action: 'raise', street: 'flop', amount: 20 }],
      shown_cards: { 1: ['As', 'Ad'] },
    });
  }
  function worker(batch = 2) {
    const worker = new FactsWorker(rawPath, derivedPath, batch);
    cleanup.push(() => worker.close());
    return worker;
  }
  return { dir, raw, rawPath, derivedPath, addHand, worker };
}
function snapshot(id: number, at: string): KnowledgeSnapshot {
  const { contentHash: _hash, ...base } = emptyFactsSnapshot();
  const content = {
    ...base,
    source: 'deterministic' as const,
    version: `facts-${id}`,
    evidenceEventId: id,
    evidenceCutoff: at,
    publishedAt: at,
  };
  return { ...content, contentHash: factsHash(content) };
}

describe('pure deterministic facts', () => {
  it('has no strategy publication tables/cards and never writes raw history', () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.addHand(i);
    const worker = f.worker();
    f.raw.exec('BEGIN IMMEDIATE');
    expect(worker.tick()).toMatchObject({ eventCursor: 6, pendingHands: 1 });
    f.raw.exec('ROLLBACK');
    const result = worker.facts.latest();
    expect(result.cards).toEqual([]);
    expect(result.version).toBe('poker-facts-v1-e6');
    expect(result.opponents[0]!.sampledHands).toBe(2);
    expect(
      worker.facts.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('knowledge_versions','advice_publications')",
        )
        .all(),
    ).toEqual([]);
    expect(
      f.raw.prepare("SELECT name FROM sqlite_master WHERE name='opponent_encounters'").get(),
    ).toBeUndefined();
  });
  it('recovers interrupted materialization before processing the next batch', () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.addHand(i);
    const worker = f.worker();
    syncOpponentMemory(f.raw, worker.facts.db, 2, '2026-01-02T00:00:00.000Z');
    expect(worker.facts.latest().opponents).toEqual([]);
    const resumed = f.worker();
    expect(resumed.tick()).toMatchObject({ eventCursor: 6, pendingHands: 2 });
    expect(resumed.facts.latest().opponents[0]!.sampledHands).toBe(2);
    resumed.tick();
    expect(resumed.facts.latest().opponents[0]!.sampledHands).toBe(4);
  });
  it('gates future completion/receipt and publication availability independently', () => {
    const f = fixture();
    f.addHand(1);
    f.addHand(2, '2026-01-04T00:00:00.000Z');
    const worker = f.worker(10);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-05T00:00:00.000Z'));
    try {
      worker.tick('2026-01-03T00:00:00.000Z');
    } finally {
      clock.mockRestore();
    }
    expect(worker.facts.latest('2026-01-04T00:00:00.000Z').opponents).toEqual([]);
    const facts = worker.facts.latest('2026-01-06T00:00:00.000Z');
    expect(facts.opponents[0]!.sampledHands).toBe(1);
    expect(facts.evidenceCutoff).toBe('2026-01-03T00:00:00.000Z');
    expect(facts.publishedAt).toBe('2026-01-05T00:00:00.000Z');
  });
  it('rejects hidden strategy text, snapshot tampering and late older publications', () => {
    const store = new FactsStore(':memory:');
    cleanup.push(() => store.close());
    const newer = snapshot(2, '2026-01-02T00:00:00.000Z');
    expect(store.appendSnapshot(newer)).toBe(true);
    expect(store.appendSnapshot(snapshot(1, '2026-01-03T00:00:00.000Z'))).toBe(false);
    expect(() => store.appendSnapshot({ ...newer, evidenceEventId: 3 })).toThrow('hash');
    expect(() =>
      store.appendSnapshot({
        ...newer,
        cards: [{ id: 'hidden', street: 'all', text: 'Always raise' }],
      }),
    ).toThrow('strategies');
    expect(store.latest().contentHash).toBe(newer.contentHash);
  });
  it('audits new framework context/proposal records and legacy knowledge without mutating input', () => {
    const f = fixture();
    const original = {
      holeCards: ['As', 'Ad'],
      board: ['Ac', 'Kd', '8h', '7h', '2c'],
      heroSeat: 0,
      seats: [
        { seat: 0, name: 'hero' },
        { seat: 1, name: 'villain', inHand: true },
      ],
    };
    const insert = f.raw.prepare('INSERT INTO decisions VALUES(?,?,?)');
    insert.run('new-context', JSON.stringify({ ...original, framework: {} }), '{}');
    insert.run('new-proposal', JSON.stringify(original), JSON.stringify({ framework: {} }));
    insert.run('legacy', JSON.stringify({ ...original, knowledge: {} }), '{}');
    insert.run('old-sync', '{}', '{}');
    insert.run('corrupt', '{not-json', '{bad-json');
    const worker = f.worker(10);
    expect(worker.tick()).toMatchObject({ decisionCursor: 5, pendingAudits: 0 });
    for (const id of ['new-context', 'new-proposal', 'legacy'])
      expect(worker.facts.getAudit(id)).toMatchObject({
        status: 'complete',
        provenance: 'asynchronous_audit_not_model_input',
      });
    expect(worker.facts.getAudit('old-sync')).toBeNull();
    expect(worker.facts.getAudit('corrupt')).toBeNull();
    const text = String(
      f.raw.prepare('SELECT context FROM decisions WHERE id=?').get('new-proposal')!.context,
    );
    expect(text).toBe(JSON.stringify(original));
    expect(worker.facts.getAudit('new-proposal')!.inputHash).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
  });
  it('reads the older admissible snapshot for a recovering hand and old audits read-only', async () => {
    const f = fixture();
    const store = new FactsStore(f.derivedPath);
    cleanup.push(() => store.close());
    store.appendSnapshot(snapshot(1, '2026-01-02T00:00:00.000Z'));
    store.appendSnapshot(snapshot(2, '2026-01-04T00:00:00.000Z'));
    const legacyPath = join(f.dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    cleanup.push(() => legacy.close());
    legacy.exec('CREATE TABLE decision_audits(decision_id TEXT,payload TEXT)');
    const audit = {
      decisionId: 'old-decision',
      inputHash: 'old-hash',
      computedAt: '2026-01-01',
      status: 'unavailable',
      uniformShowdownReference: null,
      provenance: 'asynchronous_audit_not_model_input',
    };
    legacy
      .prepare('INSERT INTO decision_audits VALUES(?,?)')
      .run('old-decision', JSON.stringify(audit));
    const service = new FactsService(f.rawPath, f.derivedPath, {
      enabled: false,
      legacyAuditPath: legacyPath,
    });
    try {
      await service.start();
      expect(service.latest().version).toBe('facts-2');
      expect(service.latest('2026-01-03T00:00:00.000Z').version).toBe('facts-1');
      expect(service.latest('2026-01-01T00:00:00.000Z')).toEqual(emptyFactsSnapshot());
      expect(service.getAudit('old-decision')).toEqual(audit);
      expect(service.status().running).toBe(false);
    } finally {
      await service.stop();
    }
  });
  it('runs isolated worker facts without credentials and preserves graceful stop/restart', async () => {
    const f = fixture();
    f.addHand(1);
    const service = new FactsService(f.rawPath, f.derivedPath, { intervalMs: 10 });
    try {
      await service.start();
      await expect.poll(() => service.latest().evidenceEventId, { timeout: 5000 }).toBe(3);
      expect(service.latest().cards).toEqual([]);
      expect(service.status().running).toBe(true);
      await service.stop();
      expect(service.status().running).toBe(false);
      await service.start();
      await expect.poll(() => service.status().running, { timeout: 5000 }).toBe(true);
      expect(service.latest().evidenceEventId).toBe(3);
    } finally {
      await service.stop();
    }
  });
});
