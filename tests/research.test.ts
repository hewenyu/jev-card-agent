import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeStore, baselineSnapshot } from '../src/knowledge/store.js';
import { snapshotHash } from '../src/knowledge/validator.js';
import { syncOpponentMemory } from '../src/storage/opponent-memory.js';
import { StatsWorker } from '../src/research/stats-worker.js';
import { SlowLoopService } from '../src/research/service.js';
const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'poker-research-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const rawPath = join(dir, 'raw.sqlite');
  const derivedPath = join(dir, 'knowledge.sqlite');
  const raw = new DatabaseSync(rawPath);
  cleanup.push(() => raw.close());
  raw.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE events(id INTEGER PRIMARY KEY,run_id TEXT,hand_id TEXT,table_id TEXT,received_at TEXT,type TEXT,payload TEXT);
    CREATE TABLE decisions(id TEXT PRIMARY KEY,context TEXT);`);
  const addHand = (index: number, received = '2026-01-01T00:00:00.000Z', completed = received) => {
    const hand = `hand-${index}`;
    const emit = (type: string, payload: unknown) =>
      raw
        .prepare(
          'INSERT INTO events(run_id,hand_id,table_id,received_at,type,payload) VALUES(?,?,?,?,?,?)',
        )
        .run('run', hand, 'table', received, type, JSON.stringify(payload));
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
  };
  const worker = (size = 2) => {
    const result = new StatsWorker(rawPath, derivedPath, size);
    cleanup.push(() => result.close());
    return result;
  };
  return { raw, rawPath, derivedPath, addHand, worker };
}
describe('isolated deterministic slow loop', () => {
  it('bounds batches, resumes cursors and cannot write or lock the raw database', () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.addHand(i);
    const worker = f.worker();
    f.raw.exec('BEGIN IMMEDIATE');
    expect(worker.tick('2026-01-02T00:00:00.000Z')).toMatchObject({
      eventCursor: 6,
      pendingHands: 3,
    });
    f.raw.exec('ROLLBACK');
    const resumed = f.worker();
    expect(resumed.tick('2026-01-03T00:00:00.000Z')).toMatchObject({
      eventCursor: 12,
      pendingHands: 1,
    });
    expect(resumed.knowledge.latest().opponents[0]?.sampledHands).toBe(4);
    expect(
      f.raw.prepare("SELECT name FROM sqlite_master WHERE name='opponent_encounters'").get(),
    ).toBeUndefined();
  });
  it('recovers a crash between materialization and publication before advancing the next batch', () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.addHand(i);
    const worker = f.worker();
    expect(syncOpponentMemory(f.raw, worker.knowledge.db, 2, '2026-01-02T00:00:00.000Z')).toBe(6);
    expect(worker.knowledge.latest().source).toBe('baseline');
    const restarted = f.worker();
    expect(restarted.tick('2026-01-03T00:00:00.000Z')).toMatchObject({
      eventCursor: 6,
      pendingHands: 3,
    });
    expect(restarted.knowledge.latest().opponents[0]?.sampledHands).toBe(2);
    expect(restarted.tick('2026-01-04T00:00:00.000Z')).toMatchObject({
      eventCursor: 12,
      pendingHands: 1,
    });
  });
  it('does not spend audit simulations on legacy synchronous-audit decisions', () => {
    const f = fixture();
    f.raw.prepare('INSERT INTO decisions VALUES(?,?)').run('legacy', '{}');
    const worker = f.worker();
    expect(worker.tick()).toMatchObject({ decisionCursor: 1, pendingAudits: 0 });
    expect(worker.knowledge.getAudit('legacy')).toBeNull();
  });
  it('timestamps publication after batch computation rather than at its evidence cutoff', () => {
    const f = fixture();
    f.addHand(1);
    const worker = f.worker();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-04T00:00:00.000Z'));
    try {
      worker.tick('2026-01-02T00:00:00.000Z');
      expect(worker.knowledge.latest('2026-01-03T00:00:00.000Z').source).toBe('baseline');
      expect(worker.knowledge.latest('2026-01-05T00:00:00.000Z')).toMatchObject({
        evidenceCutoff: '2026-01-02T00:00:00.000Z',
        publishedAt: '2026-01-04T00:00:00.000Z',
      });
    } finally {
      clock.mockRestore();
    }
  });
  it('blocks both future completion and late receipt before publishing evidence', () => {
    const f = fixture();
    f.addHand(1);
    f.addHand(2, '2026-01-04T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    f.addHand(3, '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
    const worker = f.worker(10);
    worker.tick('2026-01-03T00:00:00.000Z');
    expect(worker.knowledge.latest().opponents[0]?.sampledHands).toBe(1);
    worker.tick('2026-01-04T12:00:00.000Z');
    expect(worker.knowledge.latest().opponents[0]?.sampledHands).toBe(2);
    worker.tick('2026-01-06T00:00:00.000Z');
    expect(worker.knowledge.latest().opponents[0]?.sampledHands).toBe(3);
  });
  it('caps the rolling evidence window while preserving raw history', () => {
    const f = fixture();
    for (let i = 0; i < 205; i++) f.addHand(i);
    const worker = f.worker(100);
    for (let i = 0; i < 3; i++) worker.tick(`2026-01-0${i + 2}T00:00:00.000Z`);
    expect(worker.knowledge.latest().opponents[0]).toMatchObject({
      sampledHands: 200,
      sampleCapped: true,
    });
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(615);
  });
  it('adds bounded reproducible audits without changing saved contexts', () => {
    const f = fixture();
    const context = JSON.stringify({
      knowledge: {},
      holeCards: ['As', 'Ad'],
      board: ['Ac', 'Kd', '8h', '7h', '2c'],
      heroSeat: 0,
      seats: [
        { seat: 0, name: 'hero' },
        { seat: 1, name: 'villain', inHand: true },
      ],
    });
    for (let i = 0; i < 3; i++)
      f.raw.prepare('INSERT INTO decisions VALUES(?,?)').run(`d${i}`, context);
    const worker = f.worker(1);
    expect(worker.tick()).toMatchObject({ decisionCursor: 1, pendingAudits: 2 });
    expect(worker.knowledge.getAudit('d0')).toMatchObject({
      status: 'complete',
      inputHash: createHash('sha256').update(context).digest('hex'),
      provenance: 'asynchronous_audit_not_model_input',
    });
    expect(f.raw.prepare('SELECT context FROM decisions WHERE id=?').get('d0')?.context).toBe(
      context,
    );
    const restarted = f.worker(1);
    expect(restarted.tick()).toMatchObject({ decisionCursor: 2, pendingAudits: 1 });
  });
  it('worker startup failure does not reject or remove available baseline knowledge', async () => {
    const f = fixture();
    const service = new SlowLoopService(`${f.rawPath}.missing`, f.derivedPath, { intervalMs: 20 });
    try {
      await expect(service.start()).resolves.toBeUndefined();
      await expect.poll(() => service.status().error, { timeout: 5000 }).not.toBeNull();
      expect(service.latest().source).toBe('baseline');
      expect(service.status().error).not.toContain(f.rawPath);
    } finally {
      await service.stop();
    }
  });
  it('recovers the last admissible older publication instead of leaking the newest snapshot', async () => {
    const f = fixture();
    const knowledge = new KnowledgeStore(f.derivedPath);
    cleanup.push(() => knowledge.close());
    const { contentHash: _hash, ...base } = baselineSnapshot();
    for (let i = 1; i <= 2; i++) {
      const content = {
        ...base,
        source: 'deterministic' as const,
        version: `v${i}`,
        evidenceEventId: i,
        publishedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      };
      knowledge.publish({ ...content, contentHash: snapshotHash(content) });
    }
    const service = new SlowLoopService(f.rawPath, f.derivedPath, { enabled: false });
    try {
      await service.start();
      expect(service.latest().version).toBe('v2');
      expect(service.latest('2026-01-02T12:00:00.000Z').version).toBe('v1');
      expect(service.latest('2026-01-01T12:00:00.000Z').source).toBe('baseline');
    } finally {
      await service.stop();
    }
  });
  it('disabled workers continue using already published knowledge', async () => {
    const f = fixture();
    f.addHand(1);
    f.worker().tick();
    const service = new SlowLoopService(f.rawPath, f.derivedPath, { enabled: false });
    try {
      await service.start();
      expect(service.latest().opponents[0]?.name).toBe('villain');
      expect(service.status()).toMatchObject({
        running: false,
        enabled: false,
        latestVersion: service.latest().version,
      });
    } finally {
      await service.stop();
    }
  });
  it('runs CPU work in a separate worker and disabled mode creates no derived database', async () => {
    const f = fixture();
    f.addHand(1);
    const disabled = new SlowLoopService(f.rawPath, f.derivedPath, { enabled: false });
    await disabled.start();
    expect(disabled.status().running).toBe(false);
    await disabled.stop();
    const service = new SlowLoopService(f.rawPath, f.derivedPath, { intervalMs: 20, batchSize: 1 });
    try {
      await service.start();
      await expect.poll(() => service.status().eventCursor, { timeout: 10000 }).toBe(3);
      expect(service.latest().opponents[0]?.name).toBe('villain');
      expect(service.status().error).toBeNull();
    } finally {
      await service.stop();
    }
  });
});
