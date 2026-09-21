import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { listenAndStart } from '../src/server/startup.js';
import { Store } from '../src/storage/store.js';
import type { EvaluationView, HandDetail, Overview, RunSummary } from '../src/shared/api.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const config = {
    ...loadConfig({}, true),
    staticRoot: '/nonexistent-console-assets',
    ...overrides,
  };
  const store = new Store(':memory:');
  const app = await buildApp(config, { store });
  cleanup.push(async () => {
    await app.close();
    store.close();
  });
  return { app, store };
}

describe('console API and security boundaries', () => {
  it('publishes only ended hands anonymously and preserves administrator access', async () => {
    const token = 'public-history-admin-token-32-characters';
    const { app, store } = await fixture({ publicHistory: true, apiToken: token });
    const admin = { authorization: `Bearer ${token}` };
    // Keep the synthetic fixture; mark one recorded hand active and one ended but unverified.
    store.db
      .prepare("UPDATE hands SET status='playing',ended_at=NULL WHERE id=?")
      .run('demo-jev-hand-4');
    store.db.prepare('UPDATE hands SET complete=0,profit=NULL WHERE id=?').run('demo-jev-hand-3');
    store.appendEvent(
      'demo-jev',
      {
        type: 'your_turn',
        hand_id: 'demo-jev-hand-1',
        table_id: 'demo-table-jev',
        table_seq: 999,
        turn_token: 'public-must-not-see-turn-token',
        nested: { authorization: 'public-must-not-see-key' },
      },
      new Date().toISOString(),
    );
    store.db
      .prepare(
        "UPDATE decisions SET proposal=json_set(proposal,'$.routing.turn_token',?,'$.routing.nested.authorization',?) WHERE id=?",
      )
      .run('private-routing-turn-token', 'private-routing-authorization', 'demo-jev-hand-1-flop');
    const overview = (await app.inject('/api/overview')).json<Overview>();
    expect(overview.runtime.table?.heroCards).toEqual([]);
    expect(overview.runtime.table?.seats).toHaveLength(6);
    expect(overview.capabilities).toEqual({
      canControl: false,
      liveConfigured: false,
      jevConfigured: false,
      reasoningConfigured: false,
    });
    expect(overview.recentHands.every((hand) => hand.status === 'complete')).toBe(true);
    const hands = (await app.inject('/api/hands')).json<HandDetail['hand'][]>();
    expect(hands.some((hand) => hand.id === 'demo-jev-hand-4')).toBe(false);
    expect(hands.find((hand) => hand.id === 'demo-jev-hand-3')?.complete).toBe(false);
    const completed = await app.inject('/api/hands/demo-jev-hand-1');
    expect(completed.statusCode).toBe(200);
    expect(completed.json<HandDetail>().hand.heroCards).toEqual(['Ah', 'Kd']);
    expect(completed.body).not.toContain('public-must-not-see-turn-token');
    expect(completed.body).not.toContain('public-must-not-see-key');
    expect(completed.body).not.toContain('private-routing-turn-token');
    expect(completed.body).not.toContain('private-routing-authorization');
    expect((await app.inject('/api/decisions/demo-jev-hand-1-flop')).statusCode).toBe(200);
    expect((await app.inject('/api/hands/demo-jev-hand-4')).statusCode).toBe(404);
    expect((await app.inject('/api/decisions/demo-jev-hand-4-flop')).statusCode).toBe(404);
    expect(
      (await app.inject({ url: '/api/hands/demo-jev-hand-4', headers: admin })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/decisions/demo-jev-hand-4-flop', headers: admin })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/overview', headers: admin })).json<Overview>().capabilities
        .canControl,
    ).toBe(true);
    expect(
      (await app.inject({ url: '/api/runs', headers: { authorization: 'Bearer incorrect' } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/runtime/stop' })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/runtime/stop', headers: admin })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/evaluations',
          headers: admin,
          payload: { runId: 'demo-jev', strategy: 'baseline', limit: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject('/api/evaluations')).json<EvaluationView[]>()).toHaveLength(1);
    expect(
      (await app.inject({ url: '/api/evaluations', headers: admin })).json<EvaluationView[]>(),
    ).toHaveLength(1);
    const runs = (await app.inject('/api/runs')).json<RunSummary[]>();
    expect(runs.every((run) => run.reason === null)).toBe(true);
    expect(JSON.stringify(runs)).not.toContain('heroCards');
  });

  it('serves actual SQLite synthetic runs, hands and candidate comparisons', async () => {
    const { app } = await fixture();
    const overview = (await app.inject('/api/overview')).json<Overview>();
    expect(overview.runtime.mode).toBe('demo');
    expect(overview.runs).toHaveLength(2);
    expect(overview.metrics.hands).toBe(8);
    expect(overview.runtime.table?.seats).toHaveLength(6);
    expect(overview.capabilities).toEqual({
      canControl: true,
      liveConfigured: false,
      jevConfigured: false,
      reasoningConfigured: false,
    });
    const hand = (await app.inject('/api/hands/demo-jev-hand-1')).json<HandDetail>();
    expect(hand.decisions).toHaveLength(2);
    expect(hand.events.length).toBeGreaterThan(1);
    const evaluated = await app.inject({
      method: 'POST',
      url: '/api/evaluations',
      payload: { runId: 'demo-jev', strategy: 'baseline', limit: 8 },
    });
    expect(evaluated.statusCode).toBe(200);
    const result = evaluated.json<EvaluationView>();
    expect(result.samples).toBe(8);
    expect(result.errors).toBe(0);
    expect(result.costUsd).toBe(0);
    expect((await app.inject('/api/evaluations')).json<EvaluationView[]>()).toHaveLength(1);
    expect(
      (await app.inject({ method: 'POST', url: '/api/demo/reset', payload: {} })).statusCode,
    ).toBe(200);
    expect((await app.inject('/api/runs')).json<RunSummary[]>()).toHaveLength(2);
  });

  it('guards all private API reads and writes with a header token while keeping health non-sensitive', async () => {
    const token = 'test-console-token-with-32-characters';
    const { app } = await fixture({ apiToken: token });
    expect((await app.inject('/api/overview')).statusCode).toBe(401);
    expect((await app.inject(`/api/overview?token=${token}`)).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/runs', headers: { authorization: 'Bearer incorrect-token' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/overview', headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject('/health')).json()).toEqual({
      status: 'ok',
      service: 'jev-card-agent',
    });
  });

  it('authenticates encoded API paths before private reads and controls', async () => {
    const token = 'encoded-route-admin-token-32-characters';
    const { app } = await fixture({ apiToken: token });
    for (const prefix of ['/%61pi', '/a%70i']) {
      const overview = await app.inject(`${prefix}/overview`);
      expect(overview.statusCode).toBe(401);
      expect(overview.headers['cache-control']).toBe('no-store');
      expect(overview.body).not.toContain('heroCards');
      expect((await app.inject({ method: 'POST', url: `${prefix}/runtime/stop` })).statusCode).toBe(
        401,
      );
      const authorized = await app.inject({
        url: `${prefix}/overview`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorized.statusCode).toBe(200);
      expect(authorized.json<Overview>().runtime.table?.heroCards).toHaveLength(2);
    }
  });

  it('keeps public history restrictions on encoded routes', async () => {
    const { app, store } = await fixture({
      publicHistory: true,
      apiToken: 'encoded-public-history-admin-token',
    });
    store.db
      .prepare("UPDATE hands SET status='playing',ended_at=NULL WHERE id=?")
      .run('demo-jev-hand-4');
    for (const prefix of ['/%61pi', '/a%70i']) {
      const overview = (await app.inject(`${prefix}/overview`)).json<Overview>();
      expect(overview.runtime.table?.heroCards).toEqual([]);
      expect(overview.capabilities.canControl).toBe(false);
      expect((await app.inject(`${prefix}/hands/demo-jev-hand-4`)).statusCode).toBe(404);
      expect((await app.inject(`${prefix}/decisions/demo-jev-hand-4-flop`)).statusCode).toBe(404);
      expect((await app.inject(`${prefix}/hands/demo-jev-hand-1`)).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `${prefix}/runtime/stop` })).statusCode).toBe(
        403,
      );
    }
  });

  it('rejects cross-site mutations, hostile local Host headers and malformed controls', async () => {
    const { app } = await fixture();
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/demo/reset',
      headers: { origin: 'https://attacker.invalid' },
      payload: {},
    });
    expect(crossSite.statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/api/overview', headers: { host: 'attacker.invalid' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runtime/start',
          payload: { strategy: 'baseline', buyIn: -1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runtime/start',
          payload: { strategy: 'baseline' },
        })
      ).json().error,
    ).toContain('demo');
    expect((await app.inject('/api/hands/missing')).statusCode).toBe(404);
  });

  it('routes hybrid offline evaluation through one provider ledger without an outer duplicate reservation', async () => {
    const { app, store } = await fixture({
      demo: false,
      jevApiKey: 'test-jev',
      reasoningApiKey: 'test-reasoning',
    });
    app.controller.resetDemo();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, options) => {
      const request = JSON.parse(String(options?.body)) as {
        questions: { action: { criteria: Record<string, unknown> }; needs_analysis?: unknown };
      };
      const ids = Object.keys(request.questions.action.criteria);
      const choice = ids[0]!;
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          usage: { input_tokens: 100, output_tokens: 0 },
          answers: {
            action: {
              type: 'choice',
              choice,
              confidence: 0.8,
              probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
            },
            needs_analysis: {
              type: 'choice',
              choice: 'no',
              confidence: 0.9,
              probabilities: { yes: 0, no: 1 },
            },
          },
        }),
        { status: 200 },
      );
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/evaluations',
        payload: { runId: 'demo-jev', strategy: 'jev-reasoning', limit: 1 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<EvaluationView>().errors).toBe(0);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM usage').get()?.n).toBe(1);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM provider_usage').get()?.n).toBe(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('public read-only demo exposes synthetic data and denies every write', async () => {
    const { app } = await fixture({ host: '0.0.0.0', readOnlyDemo: true });
    const overview = (await app.inject('/api/overview')).json<Overview>();
    expect(overview.capabilities.canControl).toBe(false);
    for (const url of [
      '/api/runtime/start',
      '/api/runtime/stop',
      '/api/demo/reset',
      '/api/evaluations',
    ]) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    }
  });

  it('rejects a demo database that already contains private live data', async () => {
    const store = new Store(':memory:');
    store.beginRun({
      id: 'private',
      kind: 'live',
      strategy: 'jev',
      startedAt: new Date().toISOString(),
      config: {},
    });
    await expect(buildApp(loadConfig({}, true), { store })).rejects.toThrow('live data');
    store.close();
  });

  it('redacts authority tokens and credentials from stored replay events', async () => {
    const { app, store } = await fixture();
    store.appendEvent(
      'demo-jev',
      {
        type: 'your_turn',
        hand_id: 'demo-jev-hand-1',
        table_id: 'demo-table-jev',
        table_seq: 999,
        turn_token: 'private-token',
        nested: { authorization: 'private-key', email: 'private-email' },
      },
      new Date().toISOString(),
    );
    const response = await app.inject('/api/hands/demo-jev-hand-1');
    expect(response.body).not.toContain('private-token');
    expect(response.body).not.toContain('private-key');
    expect(response.body).not.toContain('private-email');
  });
});

describe('environment configuration', () => {
  it('keeps history private by default and requires an admin token when publishing real history', () => {
    expect(loadConfig({}).publicHistory).toBe(false);
    expect(() => loadConfig({ PUBLIC_HISTORY: 'true' })).toThrow('API_TOKEN');
    expect(() => loadConfig({ PUBLIC_HISTORY: 'yes' })).toThrow('PUBLIC_HISTORY');
    expect(
      loadConfig({ PUBLIC_HISTORY: 'true', API_TOKEN: 'public-history-token-with-32-characters' })
        .publicHistory,
    ).toBe(true);
  });
  it('defaults autostart off and validates explicit strategy and boolean values', () => {
    expect(loadConfig({})).toMatchObject({ autoStartBot: false, botStrategy: 'jev' });
    expect(loadConfig({ AUTO_START_BOT: 'true', BOT_STRATEGY: 'baseline' })).toMatchObject({
      autoStartBot: true,
      botStrategy: 'baseline',
    });
    expect(loadConfig({ AUTO_START_BOT: 'true', BOT_STRATEGY: 'jev-reasoning' }).botStrategy).toBe(
      'jev-reasoning',
    );
    expect(loadConfig({ AUTO_START_BOT: 'true' }, true).autoStartBot).toBe(false);
    expect(loadConfig({ AUTO_START_BOT: 'true', READ_ONLY_DEMO: 'true' }).autoStartBot).toBe(false);
    expect(() => loadConfig({ BOT_STRATEGY: 'unknown' })).toThrow('BOT_STRATEGY');
    expect(() => loadConfig({ AUTO_START_BOT: 'yes' })).toThrow('AUTO_START_BOT');
  });
  it('supports the existing OpenPoker key names and isolates demo credentials', () => {
    const env = {
      OPEN_POKER_API_KEY: 'secret',
      OPEN_POKER_WS_URL: 'ws://127.0.0.1:9000',
      OPEN_POKER_REST_BASE_URL: 'http://127.0.0.1:9000',
      JEV_API_KEY: 'jev-secret',
      DEMO_DATABASE_PATH: 'data/isolated-test.sqlite',
    };
    expect(loadConfig(env).openPokerApiKey).toBe('secret');
    const demo = loadConfig(env, true);
    expect(demo.openPokerApiKey).toBe('');
    expect(demo.jevApiKey).toBe('');
    expect(demo.databasePath).toContain('isolated-test.sqlite');
  });
  it('refuses unauthenticated public binding and short configured tokens', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow('API_TOKEN');
    expect(() => loadConfig({ API_TOKEN: 'short' })).toThrow('24');
    expect(loadConfig({ HOST: '0.0.0.0', READ_ONLY_DEMO: 'true' }).demo).toBe(true);
  });
});

describe('opt-in server bot startup', () => {
  function startupFixture() {
    const order: string[] = [];
    const app = {
      listen: vi.fn(async () => {
        order.push('listen');
      }),
      close: vi.fn(async () => {
        order.push('close');
      }),
      controller: {
        start: vi.fn(async () => {
          order.push('start');
          return {
            running: true,
            status: 'connecting',
            mode: 'live' as const,
            runId: 'fixture',
            strategy: 'jev' as const,
            table: null,
            error: null as string | null,
          };
        }),
      },
    };
    return { app, order };
  }
  it('starts exactly once after listening with persistent budget and continuous runtime defaults', async () => {
    const { app, order } = startupFixture();
    const config = loadConfig({
      AUTO_START_BOT: 'true',
      BOT_STRATEGY: 'baseline',
      RUN_BUDGET_USD: '0.75',
    });
    await listenAndStart(app, config);
    expect(order).toEqual(['listen', 'start']);
    expect(app.controller.start).toHaveBeenCalledTimes(1);
    expect(app.controller.start).toHaveBeenCalledWith({
      strategy: 'baseline',
      buyIn: 2000,
      autoRebuy: true,
      maxHands: 0,
      maxMinutes: 0,
      budgetUsd: 0.75,
    });
    expect(app.close).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'demo', 'readOnlyDemo'])('does not start for %s', async (mode) => {
    const { app } = startupFixture();
    const config = {
      ...loadConfig({}),
      autoStartBot: mode !== 'disabled',
      demo: mode === 'demo',
      readOnlyDemo: mode === 'readOnlyDemo',
    };
    await listenAndStart(app, config);
    expect(app.controller.start).not.toHaveBeenCalled();
    expect(app.listen).toHaveBeenCalledTimes(1);
  });
  it('closes the server and rejects if startup throws', async () => {
    const { app, order } = startupFixture();
    app.controller.start.mockRejectedValue(new Error('Missing bot credentials'));
    await expect(listenAndStart(app, loadConfig({ AUTO_START_BOT: 'true' }))).rejects.toThrow(
      'Server startup failed: Missing bot credentials',
    );
    expect(order).toEqual(['listen', 'close']);
  });
  it('closes and rejects when Runtime reports a failed start without throwing', async () => {
    const { app } = startupFixture();
    app.controller.start.mockResolvedValue({
      running: false,
      status: 'failed',
      mode: 'live',
      runId: 'fixture',
      strategy: 'jev',
      table: null,
      error: 'REST startup failed',
    });
    await expect(listenAndStart(app, loadConfig({ AUTO_START_BOT: 'true' }))).rejects.toThrow(
      'REST startup failed',
    );
    expect(app.close).toHaveBeenCalledTimes(1);
  });
  it('never starts a bot when HTTP listen fails', async () => {
    const { app } = startupFixture();
    app.listen.mockRejectedValue(new Error('EADDRINUSE'));
    await expect(listenAndStart(app, loadConfig({ AUTO_START_BOT: 'true' }))).rejects.toThrow(
      'EADDRINUSE',
    );
    expect(app.controller.start).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
