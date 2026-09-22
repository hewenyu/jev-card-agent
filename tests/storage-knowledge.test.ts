import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { createInitialState } from '../src/core/state.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { snapshotHash } from '../src/knowledge/validator.js';
import type { KnowledgeSource } from '../src/storage/knowledge.js';
import type { KnowledgeSnapshot } from '../src/knowledge/types.js';
import { loadConfig } from '../src/server/config.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const state = (id = 'hand') => ({
  ...createInitialState(),
  tableId: 'table',
  handId: id,
  heroSeat: 0,
  seats: [
    { seat: 0, name: 'hero', stack: 2000, bet: 0, status: 'active' },
    { seat: 1, name: 'opponent', stack: 2000, bet: 0, status: 'active' },
  ],
});
function published(id: number, at: string): KnowledgeSnapshot {
  const { contentHash: _hash, ...base } = baselineSnapshot();
  const content = {
    ...base,
    version: `knowledge-${id}`,
    source: 'deterministic' as const,
    evidenceEventId: id,
    evidenceCutoff: at,
    publishedAt: at,
  };
  return { ...content, contentHash: snapshotHash(content) };
}
function source(snapshot: KnowledgeSnapshot): KnowledgeSource {
  return {
    latest: () => snapshot,
    getAudit: () => null,
    status: () => ({
      enabled: false,
      running: false,
      lastCompletedAt: null,
      eventCursor: 0,
      decisionCursor: 0,
      pendingHands: 0,
      pendingAudits: 0,
      latestVersion: snapshot.version,
      error: null,
    }),
  };
}
function begin(store: Store) {
  store.beginRun({
    id: 'run',
    kind: 'live',
    strategy: 'jev',
    startedAt: '2026-01-01T00:00:00.000Z',
    config: {},
  });
}
function hand(store: Store, id: string, at: string) {
  store.appendEvent('run', { type: 'hand_start', table_id: 'table', hand_id: id, ts: at }, at);
}

describe('immutable hand knowledge in authoritative storage', () => {
  it('pins before a later publication and restores the same evidence after reopening without a worker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-pins-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'raw.sqlite');
    let store = new Store(path);
    begin(store);
    const first = published(1, '2026-01-01T00:00:01.000Z');
    store.knowledgeSource = source(first);
    hand(store, 'hand', '2026-01-01T00:00:02.000Z');
    const pinned = store.pinKnowledge(state(), '2026-01-01T00:00:02.001Z');
    expect(pinned.pin.knowledgeVersion).toBe(first.version);
    expect(Object.isFrozen(pinned.pin)).toBe(true);
    store.knowledgeSource = source(published(2, '2026-01-01T00:00:03.000Z'));
    expect(store.pinKnowledge(state(), '2026-01-01T00:00:04.000Z')).toEqual(pinned);
    store.close();
    store = new Store(path);
    cleanup.push(() => store.close());
    expect(store.pinKnowledge(state(), '2026-01-01T00:00:05.000Z')).toEqual(pinned);
    store.knowledgeSource = source(published(2, '2026-01-01T00:00:03.000Z'));
    hand(store, 'next', '2026-01-01T00:00:06.000Z');
    expect(store.pinKnowledge(state('next'), '2026-01-01T00:00:06.001Z').pin.knowledgeVersion).toBe(
      'knowledge-2',
    );
  });
  it('excludes later-published knowledge even if its evidence references older hands', () => {
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    begin(store);
    hand(store, 'hand', '2026-01-01T00:00:02.000Z');
    store.knowledgeSource = source(published(2, '2026-01-01T00:00:03.000Z'));
    expect(store.pinKnowledge(state(), '2026-01-01T00:00:04.000Z').pin.reason).toBe('baseline');
  });
  it('uses the recorded baseline on recovery without proof of the hand start or with incompatible data', () => {
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    begin(store);
    store.knowledgeSource = source(published(1, '2026-01-01T00:00:01.000Z'));
    expect(store.pinKnowledge(state(), '2026-01-01T00:00:04.000Z').pin.reason).toBe('baseline');
    hand(store, 'bad', '2026-01-01T00:00:02.000Z');
    const corrupted = published(2, '2026-01-01T00:00:01.000Z');
    corrupted.contentHash = 'wrong';
    store.knowledgeSource = source(corrupted);
    expect(store.pinKnowledge(state('bad'), '2026-01-01T00:00:04.000Z').pin.reason).toBe(
      'baseline',
    );
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM hand_knowledge').get()?.n).toBe(2);
  });
  it('uses a separate derived file by default and rejects accidental raw-database reuse', () => {
    const config = loadConfig({ DATABASE_PATH: 'data/example.sqlite' });
    expect(config.researchEnabled).toBe(true);
    expect(config.knowledgeDatabasePath).toBe(`${config.databasePath}.knowledge.sqlite`);
    expect(loadConfig({ RESEARCH_ENABLED: 'false' }).researchEnabled).toBe(false);
    expect(() =>
      loadConfig({
        DATABASE_PATH: 'data/same.sqlite',
        KNOWLEDGE_DATABASE_PATH: 'data/same.sqlite',
      }),
    ).toThrow('separate');
    expect(() => loadConfig({ RESEARCH_ENABLED: 'maybe' })).toThrow('RESEARCH_ENABLED');
  });
});
