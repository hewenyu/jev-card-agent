import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { FundingMonitor } from '../src/runtime/funding.js';
import { fundingEventId, fundingIdentity } from '../src/storage/funding.js';
import type { ServerEvent } from '../src/openpoker/protocol.js';

const run = {
  id: 'funding-run',
  kind: 'live' as const,
  strategy: 'baseline',
  startedAt: '2026-09-21T00:00:00Z',
  config: {},
};
describe('persistent funding history', () => {
  it('does not rewrite a reconciled confirmation when its provider id is replayed after a buy-in', async () => {
    const store = new Store(':memory:');
    let balance = { chipBalance: 1500, chipsAtTable: 0, pro: false, autoRebuy: true };
    const monitor = new FundingMonitor(
      { seasonBalance: async () => balance },
      () => {},
      (event, identity) => store.saveFundingEvent(event, identity),
    );
    try {
      store.beginRun(run);
      monitor.start(true, run.id);
      await monitor.refresh();
      const event: ServerEvent = { type: 'rebuy_confirmed', event_id: 'replayed-confirmation' };
      monitor.observe(event, null, 'first-observation');
      await monitor.refresh();
      const confirmed = store.recentFundingEvents().find((row) => row.kind === 'rebuy_confirmed');
      expect(confirmed).toMatchObject({ availableAfter: 1500, chipsAtTable: 0 });

      balance = { ...balance, chipBalance: 500, chipsAtTable: 1000 };
      monitor.observe(event, null, 'replayed-observation');
      await monitor.refresh();
      expect(store.recentFundingEvents().filter((row) => row.kind === 'rebuy_confirmed')).toEqual([
        confirmed,
      ]);
      expect(store.recentFundingEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'balance_sync',
            availableAfter: 500,
            chipsAtTable: 1000,
          }),
        ]),
      );
    } finally {
      monitor.stop();
      store.close();
    }
  });
  it('backfills source messages idempotently and retains distinct confirmations without provider identities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-history-'));
    const filename = join(directory, 'history.sqlite');
    let store = new Store(filename);
    try {
      store.beginRun(run);
      const confirmed: ServerEvent = {
        type: 'rebuy_confirmed',
        chip_balance: 1500,
        new_stack: 0,
        table_id: 'old-table',
        table_seq: 10,
      };
      store.appendEvent(
        run.id,
        { type: 'player_action', table_id: 'old-table', table_seq: 10 },
        '2026-09-21T00:00:00.000Z',
      );
      store.appendEvent(run.id, confirmed, '2026-09-21T00:00:00.000Z');
      store.appendEvent(run.id, confirmed, '2026-09-21T00:10:00.000Z');
      store.appendEvent(
        run.id,
        { type: 'auto_rebuy_scheduled', rebuy_at: '2026-09-21T00:20:00Z' },
        '2026-09-21T00:15:00.000Z',
      );
      store.close();
      store = new Store(filename);
      const records = store.recentFundingEvents();
      expect(records).toHaveLength(3);
      expect(records.filter((row) => row.kind === 'rebuy_confirmed')).toHaveLength(2);
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE type='rebuy_confirmed' AND seq IS NULL")
          .get()?.n,
      ).toBe(2);
      expect(
        records.every((row) => row.availableBefore === null && row.availableAfter === null),
      ).toBe(true);
      expect(records[0]?.rebuyAvailableAt).toBe('2026-09-21T00:20:00.000Z');
      expect(store.loadFundingState()).toMatchObject({
        lastRebuyAt: '2026-09-21T00:10:00.000Z',
        rebuyAvailableAt: '2026-09-21T00:20:00.000Z',
      });
      store.close();
      store = new Store(filename);
      expect(store.recentFundingEvents()).toEqual(records);
      expect(store.recentFundingEvents({ limit: 1, before: records[0]!.id })).toEqual([records[1]]);
      expect(store.recentFundingEvents({ before: 'unknown' })).toEqual([]);
    } finally {
      if (store.db.isOpen) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('deduplicates explicit provider event ids, preserving live reconciliation through later backfill', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-live-'));
    const filename = join(directory, 'history.sqlite');
    let store = new Store(filename);
    const monitor = new FundingMonitor(
      {
        seasonBalance: async () => ({
          chipBalance: 1500,
          chipsAtTable: 0,
          pro: false,
          autoRebuy: true,
        }),
      },
      () => {},
      (event, identity) => store.saveFundingEvent(event, identity),
    );
    try {
      store.beginRun(run);
      monitor.start(true, run.id);
      await monitor.refresh();
      const event: ServerEvent = { type: 'rebuy_confirmed', event_id: 'unique-confirmation' };
      const sourceId = store.appendEvent(run.id, event, '2026-09-21T00:01:00.000Z');
      monitor.observe(event, null, String(sourceId));
      await monitor.refresh();
      const nextId = store.appendEvent(run.id, event, '2026-09-21T00:01:01.000Z');
      monitor.observe(event, null, String(nextId));
      await monitor.refresh();
      const confirmations = store
        .recentFundingEvents()
        .filter((row) => row.kind === 'rebuy_confirmed');
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]).toMatchObject({ availableAfter: 1500, source: 'ws', amount: 1500 });
      expect(confirmations[0]?.id).toBe(fundingEventId(fundingIdentity(event, String(sourceId))));
      monitor.stop();
      store.close();
      store = new Store(filename);
      expect(store.recentFundingEvents().filter((row) => row.kind === 'rebuy_confirmed')).toEqual(
        confirmations,
      );
    } finally {
      monitor.stop();
      if (store.db.isOpen) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
