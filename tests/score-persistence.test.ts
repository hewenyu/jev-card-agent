import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { runPerformance } from '../src/storage/performance.js';

describe('official season score persistence', () => {
  it('agrees on the latest observation when multiple snapshots share a millisecond', () => {
    const store = new Store(':memory:');
    try {
      store.beginRun({
        id: 'run',
        kind: 'live',
        strategy: 'jev',
        startedAt: '2026-09-22T00:00:00Z',
        config: {},
      });
      const snapshot = {
        runId: 'run',
        createdAt: '2026-09-22T00:00:00Z',
        kind: 'balance_sync' as const,
        source: 'reconciliation' as const,
        amount: null,
        availableBefore: null,
        availableAfter: 1000,
        chipsAtTable: 0,
        rebuyAvailableAt: null,
        seasonId: 'season',
      };
      store.saveFundingEvent({ ...snapshot, id: 'z-earlier', seasonScore: 100 });
      store.saveFundingEvent({ ...snapshot, id: 'a-later', seasonScore: 200 });
      expect(store.loadFundingState()).toMatchObject({ seasonScore: 200 });
      expect(runPerformance(store, 'run')).toMatchObject({ score: 200 });
      const first = store.recentFundingEvents({ limit: 1 });
      expect(first[0]?.id).toBe('a-later');
      expect(store.recentFundingEvents({ limit: 1, before: first[0]!.id })[0]?.id).toBe(
        'z-earlier',
      );
    } finally {
      store.close();
    }
  });
  it('migrates legacy rows without rewriting them and restores explicit official observations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'score-history-'));
    const filename = join(directory, 'history.sqlite');
    let store = new Store(filename);
    try {
      store.beginRun({
        id: 'run',
        kind: 'live',
        strategy: 'jev',
        startedAt: '2026-09-22T00:00:00Z',
        config: {},
      });
      const legacy = {
        id: 'legacy',
        runId: 'run',
        createdAt: '2026-09-22T00:00:00Z',
        kind: 'balance_sync' as const,
        source: 'reconciliation' as const,
        amount: null,
        availableBefore: null,
        availableAfter: 1000,
        chipsAtTable: 300,
        rebuyAvailableAt: null,
      };
      store.saveFundingEvent(legacy);
      const oldView = store.recentFundingEvents();
      store.close();
      const oldDb = new DatabaseSync(filename);
      for (const column of ['season_score', 'season_id', 'score_source', 'sync_reason'])
        oldDb.exec(`ALTER TABLE funding_events DROP COLUMN ${column}`);
      const original = oldDb.prepare('SELECT * FROM funding_events').all();
      const columns = oldDb
        .prepare('PRAGMA table_info(funding_events)')
        .all()
        .map((row) => String(row.name));
      oldDb.close();
      store = new Store(filename);
      expect(store.db.prepare(`SELECT ${columns.join(',')} FROM funding_events`).all()).toEqual(
        original,
      );
      expect(store.recentFundingEvents()).toEqual(oldView);
      expect(runPerformance(store, 'run')).toMatchObject({
        score: 1300,
        scoreSource: 'legacy_balance_sum',
      });
      expect(store.loadFundingState()).toMatchObject({ seasonScore: null, seasonId: null });
      store.saveFundingEvent({
        ...legacy,
        id: 'official',
        createdAt: '2026-09-22T00:01:00Z',
        seasonScore: 900,
        seasonId: 'season',
        syncReason: 'before_join',
      });
      store.close();
      store = new Store(filename);
      expect(store.loadFundingState()).toMatchObject({
        availableChips: 1000,
        chipsAtTable: 300,
        seasonScore: 900,
        seasonId: 'season',
      });
      expect(store.recentFundingEvents()[0]).toMatchObject({
        seasonScore: 900,
        seasonId: 'season',
        syncReason: 'before_join',
      });
      expect(runPerformance(store, 'run')).toMatchObject({
        score: 900,
        scoreSource: 'official',
        seasonId: 'season',
      });
    } finally {
      if (store.db.isOpen) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
