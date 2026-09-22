import { afterEach, describe, expect, it, vi } from 'vitest';
import { FundingMonitor } from '../src/runtime/funding.js';
import type { FundingEventView, FundingView } from '../src/shared/api.js';
import type { SeasonBalance } from '../src/openpoker/client.js';

const balance = (chipBalance = 945, chipsAtTable = 473): SeasonBalance => ({
  chipBalance,
  chipsAtTable,
  autoRebuy: true,
  pro: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const monitors: FundingMonitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
});
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture(seasonBalance = vi.fn(async (_signal: AbortSignal) => balance())) {
  const views: FundingView[] = [];
  const records = new Map<string, FundingEventView>();
  const save = vi.fn((event: FundingEventView) => {
    records.set(event.id, event);
  });
  const monitor = new FundingMonitor({ seasonBalance }, (value) => views.push(value), save);
  monitors.push(monitor);
  return { monitor, views, save, records, seasonBalance };
}

describe('read-only account funding monitor', () => {
  it('refreshes rebuy balances instead of adding the rule amount and records confirmed/scheduled observations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-21T00:00:00Z');
    const f = fixture();
    f.monitor.start(true, 'run');
    await flush();
    expect(f.views.at(-1)).toMatchObject({
      availableChips: 945,
      chipsAtTable: 473,
      status: 'current',
    });
    f.monitor.observe(
      { type: 'auto_rebuy_scheduled', cooldown_seconds: 120 },
      0,
      'scheduled-source',
    );
    await flush();
    expect(f.views.at(-1)?.rebuyAvailableAt).toBe('2026-09-21T00:02:00.000Z');
    f.seasonBalance.mockResolvedValueOnce(balance(1500, 0));
    f.monitor.observe(
      { type: 'rebuy_confirmed', chip_balance: 999999, table_seq: 1 },
      0,
      'confirmed-source',
    );
    await flush();
    expect(f.views.at(-1)).toMatchObject({
      availableChips: 1500,
      chipsAtTable: 0,
      rebuyAmount: 1500,
      rebuyAvailableAt: null,
      lastRebuyAt: '2026-09-21T00:00:00.000Z',
      status: 'current',
    });
    expect([...f.records.values()].find((row) => row.kind === 'rebuy_confirmed')).toMatchObject({
      source: 'ws',
      amount: 1500,
      availableBefore: null,
      availableAfter: 1500,
    });
    expect([...f.records.values()].filter((row) => row.kind === 'balance_sync')).toHaveLength(2);
  });
  it('rejects late request results across epochs and publishes monotonically versioned status', async () => {
    const old = deferred<SeasonBalance>();
    const f = fixture(
      vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValue(balance(1500, 0)),
    );
    f.monitor.start(true, 'run');
    await flush();
    f.monitor.observe({ type: 'rebuy_confirmed' }, 0);
    await flush();
    old.resolve(balance(0, 0));
    await flush();
    expect(f.views.at(-1)?.availableChips).toBe(1500);
    const timestamps = f.views.map((view) => view.observedAt);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(timestamps).toEqual([...timestamps].sort());
  });
  it('retains the last successful snapshot on failure and polls every 15 seconds without rebuy calls', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.monitor.start(true, 'run');
    await flush();
    const updatedAt = f.views.at(-1)?.updatedAt;
    f.seasonBalance.mockRejectedValueOnce(new Error('account unavailable'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.views.at(-1)).toMatchObject({ availableChips: 945, updatedAt, status: 'stale' });
    expect(f.seasonBalance).toHaveBeenCalledTimes(2);
    f.seasonBalance.mockResolvedValueOnce({ ...balance(800, 200), pro: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.views.at(-1)).toMatchObject({
      availableChips: 800,
      status: 'current',
      rebuyCooldownSeconds: 120,
    });
  });
  it('cancels on stop and ignores late completion without writes or progress', async () => {
    vi.useFakeTimers();
    const pending = deferred<SeasonBalance>();
    const f = fixture(vi.fn(() => pending.promise));
    f.monitor.start(true, 'run');
    await flush();
    const signal = f.seasonBalance.mock.calls[0]![0];
    f.monitor.stop();
    expect(signal.aborted).toBe(true);
    const published = f.views.length;
    const writes = f.save.mock.calls.length;
    pending.resolve(balance(1500));
    await flush();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.views).toHaveLength(published);
    expect(f.views.at(-1)?.status).toBe('stale');
    expect(f.save).toHaveBeenCalledTimes(writes);
    expect(f.seasonBalance).toHaveBeenCalledTimes(1);
  });
  it('records REST confirmation separately and never labels ordinary account changes a rebuy', async () => {
    const f = fixture();
    f.monitor.start(true, 'run');
    await flush();
    f.seasonBalance.mockResolvedValueOnce(balance(5000, 0));
    await f.monitor.refresh();
    expect([...f.records.values()].every((row) => row.kind === 'balance_sync')).toBe(true);
    f.monitor.restRebuy({ status: 'confirmed' });
    await flush();
    expect([...f.records.values()].find((row) => row.kind === 'rebuy_confirmed')).toMatchObject({
      source: 'rest',
      amount: 1500,
    });
  });
  it('restores known balances and cooldown as stale while startup reconciliation is pending', async () => {
    const pending = deferred<SeasonBalance>();
    const f = fixture(vi.fn(() => pending.promise));
    f.monitor.start(true, 'new-run', {
      availableChips: 800,
      chipsAtTable: 0,
      updatedAt: '2026-09-21T00:00:00Z',
      lastRebuyAt: '2026-09-20T23:59:00Z',
      rebuyAvailableAt: '2026-09-21T00:04:00Z',
    });
    await flush();
    expect(f.views.at(-1)).toMatchObject({
      availableChips: 800,
      status: 'stale',
      rebuyAvailableAt: '2026-09-21T00:04:00Z',
      lastRebuyAt: '2026-09-20T23:59:00Z',
    });
    pending.resolve(balance(1500, 0));
    await flush();
    expect(f.views.at(-1)).toMatchObject({ availableChips: 1500, status: 'current' });
  });
  it('marks a missing season as unknown rather than inventing zero chips', async () => {
    const views: FundingView[] = [];
    const monitor = new FundingMonitor({ seasonBalance: async () => null }, (value) =>
      views.push(value),
    );
    monitors.push(monitor);
    monitor.start(true);
    await flush();
    expect(views.at(-1)).toMatchObject({
      availableChips: null,
      chipsAtTable: null,
      status: 'current',
    });
  });
  it('records the first snapshot of every run even when restored balances and scores are identical', async () => {
    const f = fixture(
      vi.fn(async () => ({ ...balance(1500, 0), score: 742, seasonId: 'season-a' })),
    );
    const restored = {
      availableChips: 1500,
      chipsAtTable: 0,
      seasonScore: 742,
      seasonId: 'season-a',
      updatedAt: '2026-09-21T00:00:00.000Z',
    };
    await f.monitor.start(true, 'new-run', restored);
    expect([...f.records.values()]).toContainEqual(
      expect.objectContaining({
        runId: 'new-run',
        kind: 'balance_sync',
        syncReason: 'startup',
        seasonScore: 742,
        availableBefore: 1500,
        availableAfter: 1500,
      }),
    );
    expect(
      f.monitor.reconcile({ ...balance(1500, 0), score: 742, seasonId: 'season-a' }, 'before_join'),
    ).toBe(true);
    await f.monitor.refresh('table_joined');
    await f.monitor.refresh('after_leave');
    expect([...f.records.values()].map((event) => event.syncReason)).toEqual([
      'startup',
      'before_join',
      'table_joined',
      'after_leave',
    ]);
  });
  it('records score-only and season-only changes and never derives absent score from chip balances', async () => {
    const f = fixture(vi.fn(async () => ({ ...balance(1500, 800), score: 20, seasonId: 'a' })));
    await f.monitor.start(true, 'run');
    f.monitor.reconcile({ ...balance(1500, 800), score: 30, seasonId: 'a' }, 'poll');
    f.monitor.reconcile({ ...balance(1500, 800), score: 30, seasonId: 'b' }, 'poll');
    f.monitor.reconcile(balance(1500, 800), 'poll');
    expect([...f.records.values()].map((event) => [event.seasonScore, event.seasonId])).toEqual([
      [20, 'a'],
      [30, 'a'],
      [30, 'b'],
      [null, null],
    ]);
    expect(f.views.at(-1)).toMatchObject({
      availableChips: 1500,
      chipsAtTable: 800,
      seasonScore: null,
      seasonId: null,
      status: 'current',
    });
  });
  it('does not let an older monitor response replace the exact pre-join official observation', async () => {
    const old = deferred<SeasonBalance>();
    const f = fixture(vi.fn(() => old.promise));
    const startup = f.monitor.start(true, 'run');
    f.monitor.reconcile({ ...balance(1500, 0), score: 800, seasonId: 'new' }, 'before_join');
    old.resolve({ ...balance(100, 0), score: 0, seasonId: 'old' });
    await startup;
    expect(f.views.at(-1)).toMatchObject({
      availableChips: 1500,
      seasonScore: 800,
      seasonId: 'new',
    });
    expect([...f.records.values()].every((event) => event.seasonScore === 800)).toBe(true);
  });
  it('keeps a table-entry boundary pending if an event refresh supersedes its request', async () => {
    const f = fixture();
    await f.monitor.start(true, 'run');
    const old = deferred<SeasonBalance>();
    f.seasonBalance.mockImplementationOnce(() => old.promise);
    f.monitor.observe({ type: 'table_joined' }, 0);
    await flush();
    f.monitor.observe({ type: 'hand_result' }, 0);
    await flush();
    old.resolve(balance(1, 1));
    await flush();
    expect(
      [...f.records.values()].filter((event) => event.syncReason === 'table_joined'),
    ).toHaveLength(1);
    expect(f.views.at(-1)?.availableChips).toBe(945);
  });
  it('fails reconciliation closed on persistence errors and preserves the last successful observation', async () => {
    const f = fixture();
    await f.monitor.start(true, 'run');
    f.save.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    expect(f.monitor.reconcile({ ...balance(1900, 0), score: 99 }, 'before_join')).toBe(false);
    expect(f.views.at(-1)).toMatchObject({
      availableChips: 945,
      seasonScore: null,
      status: 'stale',
    });
    expect(f.monitor.reconcile({ ...balance(1900, 0), score: 99 }, 'before_join')).toBe(true);
    expect([...f.records.values()]).toContainEqual(
      expect.objectContaining({
        syncReason: 'before_join',
        availableAfter: 1900,
        seasonScore: 99,
      }),
    );
  });
  it('bounds an uncooperative final account request and ignores its late result', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.monitor.start(true, 'run');
    const pending = deferred<SeasonBalance>();
    f.seasonBalance.mockImplementationOnce(() => pending.promise);
    const final = f.monitor.refresh('after_leave');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await final).toBe(false);
    expect(f.views.at(-1)?.status).toBe('stale');
    const count = f.records.size;
    f.monitor.stop();
    pending.resolve(balance(999999, 0));
    await flush();
    expect(f.records.size).toBe(count);
    expect(f.views.at(-1)?.availableChips).toBe(945);
  });
  it('retains a successfully reconciled departure as current after stopping polling', async () => {
    const f = fixture();
    await f.monitor.start(true, 'run');
    expect(await f.monitor.refresh('after_leave')).toBe(true);
    f.monitor.stop(true);
    expect(f.views.at(-1)?.status).toBe('current');
  });
});
