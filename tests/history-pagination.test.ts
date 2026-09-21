import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { Queries } from '../src/storage/queries.js';
import { seedDemo } from '../src/storage/demo.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import type { HandSummary, RunSummary } from '../src/shared/api.js';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  seedDemo(store);
  store.db.exec(
    "UPDATE hands SET started_at='2026-01-01T00:00:00Z'; UPDATE runs SET started_at='2026-01-01T00:00:00Z';",
  );
  return { store, queries: new Queries(store) };
}

it('uses a stable timestamp/id cursor across tied hands and newly inserted hands', () => {
  const { store, queries } = fixture();
  const initial = queries.hands().map((hand) => hand.id);
  const first = queries.hands(undefined, { limit: 3 });
  store.db
    .exec(`INSERT INTO hands SELECT 'new-hand',run_id,table_id,hand_number,board,hero_cards,profit,
    big_blind,status,'2026-02-01T00:00:00Z',ended_at,complete,initial_stack,final_stack FROM hands LIMIT 1`);
  const rest = queries.hands(undefined, { limit: 500, before: first.at(-1)!.id });
  expect([...first, ...rest].map((hand) => hand.id)).toEqual(initial);
  expect(queries.hands('demo-jev', { limit: 2 }).every((hand) => hand.runId === 'demo-jev')).toBe(
    true,
  );
  expect(queries.hands(undefined, { before: 'unknown' })).toEqual([]);
});

it('paginates all runs including tied timestamps and runs older than the overview window', () => {
  const { store, queries } = fixture();
  const first = queries.runs({ limit: 1 });
  expect(queries.runs({ limit: 1, before: first[0]!.id })[0]!.id).not.toBe(first[0]!.id);
  store.db
    .exec(`INSERT INTO runs SELECT 'new-run',mode,strategy,model,status,'2026-02-01T00:00:00Z',
    ended_at,reason,config FROM runs LIMIT 1`);
  expect(queries.runs({ before: first[0]!.id })).toHaveLength(1);
  expect(queries.runs({ before: 'unknown' })).toEqual([]);
});

it('applies public completion filtering before page limits and validates API cursors', async () => {
  const { store } = fixture();
  const app = await buildApp(
    {
      ...loadConfig({}, true),
      publicHistory: true,
      apiToken: 'public-test-token-32-characters-long',
      staticRoot: '/nonexistent',
    },
    { store },
  );
  try {
    store.db.exec("UPDATE hands SET status='playing' WHERE id='demo-jev-hand-4'");
    const first = (await app.inject('/api/hands?limit=2')).json<HandSummary[]>();
    expect(first).toHaveLength(2);
    expect(first.every((hand) => hand.status === 'complete')).toBe(true);
    const second = (await app.inject(`/api/hands?limit=500&before=${first.at(-1)!.id}`)).json<
      HandSummary[]
    >();
    expect(new Set([...first, ...second].map((hand) => hand.id)).size).toBe(7);
    const runs = (await app.inject('/api/runs?limit=1')).json<RunSummary[]>();
    expect(runs).toHaveLength(1);
    expect(
      (await app.inject(`/api/runs?before=${runs[0]!.id}&limit=1`)).json<RunSummary[]>(),
    ).toHaveLength(1);
    for (const query of ['limit=0', 'limit=501', 'limit=1.5', 'before=']) {
      expect((await app.inject(`/api/hands?${query}`)).statusCode).toBe(400);
    }
  } finally {
    await app.close();
  }
});
