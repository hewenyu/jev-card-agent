import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';
import { publicRuntime } from '../src/server/spectator.js';
import type { LiveDecisions } from '../src/shared/api.js';

describe('public live hand review', () => {
  it('shows the bot cards and saved analysis for the exact current hand, never credentials or foreign sessions', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(
      {
        ...loadConfig({}, true),
        apiToken: 'live-decision-admin-32-characters',
        publicHistory: true,
      },
      { store },
    );
    try {
      store.db.prepare("UPDATE hands SET status='playing' WHERE id='demo-jev-hand-4'").run();
      store.db
        .prepare(
          "UPDATE decisions SET proposal=json_set(proposal,'$.routing.analysis',?,'$.routing.thinking',?,'$.routing.turn_token',?,'$.routing.nested.authorization',?) WHERE hand_id=?",
        )
        .run(
          'Explicit provider analysis',
          'Available summary',
          'secret-turn',
          'secret-header',
          'demo-jev-hand-4',
        );
      const response = await app.inject('/api/live/decisions');
      expect(response.statusCode).toBe(200);
      const result = response.json<LiveDecisions>();
      expect(result.session?.handId).toBe('demo-jev-hand-4');
      expect(result.decisions.length).toBeGreaterThan(0);
      expect(result.decisions.every((decision) => decision.handId === result.session?.handId)).toBe(
        true,
      );
      expect(result.decisions[0]?.routing?.analysis).toBe('Explicit provider analysis');
      expect(response.body).not.toMatch(/secret-turn|secret-header|turn_token|authorization/);
      expect(
        (await app.inject({ method: 'POST', url: '/api/runtime/stop', payload: {} })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/api/live/decisions',
            headers: { authorization: 'Bearer invalid' },
          })
        ).statusCode,
      ).toBe(401);
      const view = app.controller.view();
      expect(publicRuntime(view).table?.heroCards).toEqual(['Qh', 'Qs']);
      vi.spyOn(app.controller, 'view').mockReturnValue({ ...view, table: null });
      expect((await app.inject('/api/live/decisions')).json()).toEqual({
        session: null,
        decisions: [],
      });
    } finally {
      await app.close();
      store.close();
    }
  });
  it('projects only current-hand progress metadata and never unfinished model text', () => {
    const state = {
      running: true,
      status: 'playing',
      mode: 'live' as const,
      runId: 'run',
      strategy: 'jev-reasoning' as const,
      error: null,
      table: {
        tableId: 'table',
        handId: 'hand',
        street: 'flop',
        pot: 20,
        board: [],
        heroCards: ['As', 'Kd'],
        heroSeat: 0,
        dealerSeat: 1,
        seats: [],
      },
      decision: {
        id: 'decision',
        sessionId: 'session',
        tableId: 'table',
        handId: 'hand',
        phase: 'reasoning' as const,
        startedAt: 'now',
        updatedAt: 'now',
        analysis: 'uncommitted-analysis',
        turn_token: 'private-token',
      },
    };
    const result = publicRuntime(state);
    expect(result.decision?.phase).toBe('reasoning');
    expect(JSON.stringify(result)).not.toMatch(/uncommitted-analysis|private-token/);
    expect(
      publicRuntime({ ...state, table: { ...state.table, handId: 'next' } }).decision,
    ).toBeNull();
  });
});
