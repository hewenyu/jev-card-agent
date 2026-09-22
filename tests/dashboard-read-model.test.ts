import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import type { Dashboard, HandAudits } from '../src/shared/api.js';
import { cachedRead } from '../src/storage/read-cache.js';
import { Queries } from '../src/storage/queries.js';
import { runPerformance } from '../src/storage/performance.js';
import { Store } from '../src/storage/store.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(filename = ':memory:') {
  const store = new Store(filename);
  cleanup.push(() => store.close());
  store.db.exec(`INSERT INTO runs(id,mode,strategy,model,status,started_at,config)
    VALUES('r','live','jev','test','running','2026-09-22T00:00:00Z','{}');
    INSERT INTO hands(id,run_id,table_id,hand_number,board,hero_cards,profit,big_blind,status,started_at,complete)
    VALUES('h','r','t',1,'[]','[]',20,10,'complete','2026-09-22T00:01:00Z',1);
    INSERT INTO decisions(id,run_id,hand_id,street,created_at,context,candidates,proposal,source,status,latency_ms,cost_usd)
    VALUES('d','r','h','flop','2026-09-22T00:01:00Z','{}','[]','{}','jev','sent',25,0.01);`);
  return store;
}

describe('revision-based dashboard reads', () => {
  it('reuses results until committed source data changes, including other connections and rollbacks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-read-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'history.sqlite');
    const store = fixture(filename);
    const query = new Queries(store);
    const compute = vi.fn(() => query.runs()[0]!.netChips);
    const read = () => cachedRead(store.db, 'test-profit', ['hands'], compute);
    expect(read()).toBe(20);
    expect(read()).toBe(20);
    expect(compute).toHaveBeenCalledTimes(1);
    const writer = new Store(filename);
    cleanup.push(() => writer.close());
    writer.db.exec("UPDATE hands SET profit=45 WHERE id='h'");
    expect(read()).toBe(45);
    expect(compute).toHaveBeenCalledTimes(2);
    writer.db.exec("BEGIN; UPDATE hands SET profit=99 WHERE id='h'; ROLLBACK;");
    expect(read()).toBe(45);
    expect(compute).toHaveBeenCalledTimes(2);
    store.db.exec("BEGIN; UPDATE hands SET profit=99 WHERE id='h';");
    expect(query.runs()[0]!.netChips).toBe(99);
    store.db.exec('ROLLBACK');
    store.db.exec("UPDATE hands SET profit=45 WHERE id='h'");
    expect(query.runs()[0]!.netChips).toBe(45);
    writer.db.exec("DELETE FROM hands WHERE id='h'");
    expect(read()).toBe(0);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('invalidates usage, decision status and settlement without a TTL and protects cached values', () => {
    const store = fixture();
    const queries = new Queries(store);
    expect(queries.runs()[0]).toMatchObject({ costUsd: 0.01, netChips: 20 });
    expect(queries.metrics('live')).toMatchObject({ unresolved: 1, costUsd: 0.01 });
    const returned = queries.runs();
    returned[0]!.netChips = 999;
    expect(queries.runs()[0]!.netChips).toBe(20);
    store.db.exec(`UPDATE decisions SET status='acknowledged' WHERE id='d';
      INSERT INTO usage(id,run_id,reserved_nanos,status,created_at)
      VALUES('u','r',100000000,'reserved','2026-09-22T00:01:00Z');`);
    expect(queries.runs()[0]!.costUsd).toBe(0.1);
    expect(queries.metrics('live')).toMatchObject({ unresolved: 0, costUsd: 0.1 });
    store.db.exec(
      "UPDATE usage SET charged_nanos=50000000 WHERE id='u'; UPDATE hands SET profit=-30 WHERE id='h';",
    );
    expect(queries.runs()[0]).toMatchObject({ costUsd: 0.05, netChips: -30 });
    expect(queries.metrics('live')).toMatchObject({ costUsd: 0.05, netChips: -30 });
    expect(runPerformance(store, 'r')).toMatchObject({ netChips: -30, winRate: 0 });
    store.saveFundingEvent({
      id: 'f',
      runId: 'r',
      createdAt: '2026-09-22T00:02:00Z',
      kind: 'balance_sync',
      source: 'rest',
      amount: null,
      availableBefore: null,
      availableAfter: 3000,
      chipsAtTable: 1000,
      seasonScore: 2000,
      seasonId: 's',
      rebuyAvailableAt: null,
    });
    expect(runPerformance(store, 'r')).toMatchObject({ score: 2000, netChips: -30 });
    store.db.exec("UPDATE funding_events SET season_score=2500 WHERE id='f'");
    expect(runPerformance(store, 'r')!.score).toBe(2500);
  });

  it('shares expensive aggregates between viewers while unrelated event writes keep their cache valid', () => {
    const store = fixture();
    const first = new Queries(store);
    const second = new Queries(store);
    first.runs();
    first.metrics('live');
    runPerformance(store, 'r');
    const prepare = vi.spyOn(store.db, 'prepare');
    first.runs();
    second.runs();
    first.metrics('live');
    runPerformance(store, 'r');
    expect(
      prepare.mock.calls.every(([sql]) => sql === 'SELECT source,revision FROM read_revisions'),
    ).toBe(true);
    store.db.exec(
      "INSERT INTO events(run_id,type,received_at,payload) VALUES('r','heartbeat','2026-09-22T00:03:00Z','{}')",
    );
    prepare.mockClear();
    second.metrics('live');
    expect(prepare.mock.calls).toHaveLength(1);
    store.db.exec(
      "UPDATE decisions SET status=status,context='{\"newAuditOnlyField\":true}' WHERE id='d'",
    );
    prepare.mockClear();
    second.runs();
    expect(prepare.mock.calls).toHaveLength(1);
  });

  it('bundles anonymous statistics consistently, supports visible views and preserves read-only permissions', async () => {
    const store = fixture();
    const app = await buildApp(
      {
        ...loadConfig({}, false),
        publicHistory: true,
        apiToken: 'private-dashboard-admin-token',
        staticRoot: '/nonexistent-assets',
      },
      { store },
    );
    cleanup.push(() => app.close());
    store.db.exec("UPDATE runs SET reason='private reason' WHERE id='r'");
    const metrics = vi.spyOn(app.controller.queries, 'metrics');
    const hands = vi.spyOn(app.controller.queries, 'hands');
    const legacyOverview = vi.spyOn(app.controller, 'overview');
    const response = await app.inject('/api/dashboard');
    expect(response.statusCode).toBe(200);
    const body = response.json<Dashboard>();
    expect(body.overview.runs[0]).toMatchObject({ reason: null, netChips: 20 });
    expect(body.overview.capabilities.canControl).toBe(false);
    expect(body.performance).toMatchObject({ runId: 'r', netChips: 20 });
    expect(response.headers['cache-control']).toBe('no-store');
    store.db.exec("UPDATE hands SET profit=50 WHERE id='h'");
    const next = (await app.inject('/api/dashboard')).json<Dashboard>();
    expect(next.overview.runs[0]!.netChips).toBe(50);
    expect(next.overview).not.toHaveProperty('metrics');
    expect(next.overview).not.toHaveProperty('recentHands');
    expect(next.overview).not.toHaveProperty('performance');
    expect(next.performance!.netChips).toBe(50);
    expect((await app.inject('/api/dashboard?view=live')).json<Dashboard>().performance).toBeNull();
    expect(
      (await app.inject('/api/dashboard?runId=missing')).json<Dashboard>().performance,
    ).toBeNull();
    expect(
      (await app.inject({ url: '/api/dashboard', headers: { authorization: 'Bearer wrong' } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/runtime/stop' })).statusCode).toBe(403);
    expect((await app.inject('/api/hands/h/audits')).json<HandAudits>()).toEqual([
      { decisionId: 'd', audit: null },
    ]);
    store.db.exec("UPDATE hands SET status='playing' WHERE id='h'");
    expect((await app.inject('/api/hands/h/audits')).statusCode).toBe(404);
    expect(metrics).not.toHaveBeenCalled();
    expect(hands).not.toHaveBeenCalled();
    expect(legacyOverview).not.toHaveBeenCalled();
  });

  it('keeps dashboard aggregates on one snapshot when another process settles during a read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-snapshot-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'history.sqlite');
    const store = fixture(filename);
    const writer = new Store(filename);
    cleanup.push(() => writer.close());
    const app = await buildApp(
      { ...loadConfig({}, false), staticRoot: '/nonexistent-assets' },
      { store },
    );
    cleanup.push(() => app.close());
    const prepare = store.db.prepare.bind(store.db);
    let changed = false;
    vi.spyOn(store.db, 'prepare').mockImplementation((sql) => {
      if (!changed && sql.includes('COUNT(CASE WHEN complete=1 AND profit IS NOT NULL')) {
        changed = true;
        writer.db.exec("UPDATE hands SET profit=75 WHERE id='h'");
      }
      return prepare(sql);
    });
    const response = (await app.inject('/api/dashboard')).json<Dashboard>();
    expect(changed).toBe(true);
    expect(response.overview.runs[0]!.netChips).toBe(20);
    expect(response.performance!.netChips).toBe(20);
    const next = (await app.inject('/api/dashboard')).json<Dashboard>();
    expect(next.overview.runs[0]!.netChips).toBe(75);
    expect(next.performance!.netChips).toBe(75);
  });

  it('returns current runtime when chart computation fails without concealing the error', async () => {
    const store = fixture();
    const app = await buildApp(
      { ...loadConfig({}, false), staticRoot: '/nonexistent-assets' },
      { store },
    );
    cleanup.push(() => app.close());
    const prepare = store.db.prepare.bind(store.db);
    vi.spyOn(store.db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('COUNT(CASE WHEN complete=1 AND profit IS NOT NULL'))
        throw new Error('private database detail');
      return prepare(sql);
    });
    const response = await app.inject('/api/dashboard');
    expect(response.statusCode).toBe(200);
    expect(response.json<Dashboard>()).toMatchObject({
      performance: null,
      performanceError: 'Statistics refresh unavailable',
      overview: { runtime: { mode: 'idle' } },
    });
    expect(response.body).not.toContain('private database detail');
  });
});
