import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import type { FundingEventView, PerformanceView } from '../src/shared/api.js';
import { runPerformance } from '../src/storage/performance.js';
import { Store } from '../src/storage/store.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const at = (index: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();

function fixture() {
  const store = new Store(':memory:');
  cleanup.push(() => store.close());
  for (const id of ['main', 'other', 'empty'])
    store.db
      .prepare(
        `INSERT INTO runs(id,mode,strategy,model,status,started_at,config)
         VALUES(?,'live','jev','fixture','stopped',?,'{}')`,
      )
      .run(id, at(0));
  return store;
}

function hand(
  store: Store,
  id: string,
  profit: number | null,
  options: { runId?: string; index?: number; complete?: boolean; status?: string } = {},
) {
  store.db
    .prepare(
      `INSERT INTO hands
       (id,run_id,table_id,hand_number,board,hero_cards,profit,big_blind,status,started_at,ended_at,complete)
       VALUES(?,?,'table',?,'[]','[]',?,20,?,?,?,?)`,
    )
    .run(
      id,
      options.runId ?? 'main',
      options.index ?? 1,
      profit,
      options.status ?? 'complete',
      at(options.index ?? 1),
      at(options.index ?? 1),
      options.complete === false ? 0 : 1,
    );
}

function balance(
  store: Store,
  id: string,
  availableAfter: number | null,
  chipsAtTable: number | null,
  options: Partial<FundingEventView> = {},
) {
  store.saveFundingEvent({
    id,
    runId: 'main',
    createdAt: at(1),
    kind: 'balance_sync',
    source: 'rest',
    amount: null,
    availableBefore: null,
    availableAfter,
    chipsAtTable,
    rebuyAvailableAt: null,
    ...options,
  });
}

describe('complete Run performance statistics', () => {
  it('counts positive, negative and zero verified results while excluding unknown or active hands', () => {
    const store = fixture();
    hand(store, 'win', 100);
    hand(store, 'loss', -40, { index: 2 });
    hand(store, 'tie', 0, { index: 3 });
    hand(store, 'unknown', null, { index: 4 });
    hand(store, 'incomplete', 900, { index: 5, complete: false });
    hand(store, 'active', 500, { index: 6, status: 'playing' });
    hand(store, 'other-win', 7000, { runId: 'other' });
    const result = runPerformance(store, 'main')!;
    expect(result).toMatchObject({
      runId: 'main',
      settledHands: 3,
      wonHands: 1,
      excludedHands: 2,
      netChips: 60,
      score: null,
      scoreObservedAt: null,
      scorePoints: [],
    });
    expect(result.winRate).toBeCloseTo(100 / 3);
    expect(result.profitPoints.map((point) => point.netChips)).toEqual([100, 60, 60]);
    expect(runPerformance(store, 'other')).toMatchObject({ netChips: 7000, winRate: 100 });
  });

  it('uses all history before sampling at most 500 cumulative points with both endpoints', () => {
    const store = fixture();
    for (let index = 1001; index >= 1; index--) {
      hand(store, `hand-${index}`, index % 2 ? 10 : -4, { index });
      balance(store, `balance-${index}`, index, 2000, { createdAt: at(index) });
    }
    const result = runPerformance(store, 'main')!;
    expect(result).toMatchObject({
      settledHands: 1001,
      wonHands: 501,
      netChips: 3010,
      score: 3001,
    });
    expect(result.profitPoints).toHaveLength(500);
    expect(result.profitPoints[0]).toEqual({
      at: at(1),
      handNumber: 1,
      settledHands: 1,
      netChips: 10,
    });
    expect(result.profitPoints.at(-1)).toEqual({
      at: at(1001),
      handNumber: 1001,
      settledHands: 1001,
      netChips: result.netChips,
    });
    for (const point of result.profitPoints) {
      const completedPairs = Math.floor(point.settledHands / 2);
      expect(point.netChips).toBe(completedPairs * 6 + (point.settledHands % 2 ? 10 : 0));
    }
    expect(result.scorePoints).toHaveLength(500);
    expect(result.scorePoints[0]).toEqual({ at: at(1), score: 2001 });
    expect(result.scorePoints.at(-1)).toEqual({ at: at(1001), score: 3001 });
    expect(result.scoreObservedAt).toBe(at(1001));
  });

  it('takes only complete official balance snapshots and never counts rebuy as hand profit', () => {
    const store = fixture();
    hand(store, 'loss', -200);
    balance(store, 'first', 0, 900);
    balance(store, 'rebuy', 1500, 0, {
      createdAt: at(2),
      kind: 'rebuy_confirmed',
      amount: 1500,
    });
    balance(store, 'after-rebuy', 1500, 0, { createdAt: at(3), source: 'reconciliation' });
    balance(store, 'unknown-available', null, 4000, { createdAt: at(4) });
    balance(store, 'unknown-stack', 8000, null, { createdAt: at(5) });
    balance(store, 'ws', 9000, 9000, { createdAt: at(6), source: 'ws' });
    balance(store, 'other', 99000, 99000, { createdAt: at(7), runId: 'other' });
    expect(runPerformance(store, 'main')).toMatchObject({
      netChips: -200,
      winRate: 0,
      score: 1500,
      scoreObservedAt: at(3),
      scorePoints: [
        { at: at(1), score: 900 },
        { at: at(3), score: 1500 },
      ],
    });
  });

  it('orders identical timestamps by id and keeps a real zero score', () => {
    const store = fixture();
    hand(store, 'b', -10);
    hand(store, 'a', 30);
    balance(store, 'b', 0, 0);
    balance(store, 'a', 5, 5);
    const result = runPerformance(store, 'main')!;
    expect(result.profitPoints.map((point) => point.netChips)).toEqual([30, 20]);
    expect(result.scorePoints.map((point) => point.score)).toEqual([10, 0]);
    expect(result.score).toBe(0);
  });

  it('distinguishes no verified results and absent scores from zero-valued observations', () => {
    const store = fixture();
    hand(store, 'unknown', null, { runId: 'empty', complete: false });
    balance(store, 'unknown', null, 0, { runId: 'empty' });
    expect(runPerformance(store, 'empty')).toEqual({
      runId: 'empty',
      settledHands: 0,
      wonHands: 0,
      excludedHands: 1,
      netChips: 0,
      winRate: null,
      score: null,
      scoreObservedAt: null,
      profitPoints: [],
      scorePoints: [],
    });
    expect(runPerformance(store, 'missing')).toBeNull();
  });

  it('serves live-updated anonymous statistics, 404 for missing Runs and denies public writes', async () => {
    const store = fixture();
    const app = await buildApp(
      {
        ...loadConfig({}, false),
        publicHistory: true,
        apiToken: 'test-performance-admin-token-32-characters',
        staticRoot: '/nonexistent-console-assets',
      },
      { store },
    );
    cleanup.push(() => app.close());
    const url = '/api/runs/main/performance';
    const initial = await app.inject(url);
    expect(initial.statusCode).toBe(200);
    expect(initial.json<PerformanceView>().settledHands).toBe(0);
    expect(initial.headers['cache-control']).toBe('no-store');
    hand(store, 'new-result', 25);
    balance(store, 'new-balance', 700, 1800);
    expect((await app.inject(url)).json<PerformanceView>()).toMatchObject({
      settledHands: 1,
      netChips: 25,
      winRate: 100,
      score: 2500,
    });
    expect((await app.inject('/api/runs/missing/performance')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/runtime/stop' })).statusCode).toBe(403);
    expect(
      (await app.inject({ url, headers: { authorization: 'Bearer incorrect' } })).statusCode,
    ).toBe(401);
  });
});
