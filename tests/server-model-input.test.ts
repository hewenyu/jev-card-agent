import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';
import type { DecisionView } from '../src/shared/api.js';

describe('public saved Jev input', () => {
  it('publishes only saved successful Jev state and questions, redacts credentials and preserves historical input without rebuilding it', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(
      {
        ...loadConfig({}, true),
        publicHistory: true,
        apiToken: 'model-input-private-admin-32-characters',
      },
      { store },
    );
    try {
      const id = 'demo-jev-hand-1-flop';
      const url = `/api/decisions/${id}`;
      const legacy = (await app.inject(url)).json<DecisionView>();
      expect(legacy.modelInput).toBeUndefined();
      expect(legacy.modelQuestions).toBeUndefined();
      const row = store.db.prepare('SELECT context,proposal FROM decisions WHERE id=?').get(id)!;
      const context = JSON.parse(String(row.context)) as Record<string, unknown>;
      const proposal = JSON.parse(String(row.proposal)) as Record<string, unknown>;
      const state = {
        oldFormat: 'Preserve this saved request exactly',
        holeCards: ['Ah', 'Kd'],
        recentOutcomes: [{ profitBb: -2, api_key: 'private-history-key' }],
        turn_token: 'private-turn-token',
        nested: { authorization: 'private-nested-auth', visible: 'retained' },
      };
      const questions = {
        action: {
          instructions: 'Saved historical instructions',
          criteria: { call: { additionalChips: 20 } },
        },
        apiKey: 'private-question-key',
      };
      store.db.prepare('UPDATE decisions SET context=?,proposal=? WHERE id=?').run(
        JSON.stringify({ ...context, auditOnlyMarker: 'not-sent-to-model' }),
        JSON.stringify({
          ...proposal,
          source: 'jev',
          request: {
            state,
            questions,
            headers: {
              authorization: 'private-request-header',
              'x-secret': 'private-extra-header',
            },
          },
        }),
        id,
      );
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      const view = response.json<DecisionView>();
      expect(view.modelInput).toEqual({
        oldFormat: state.oldFormat,
        holeCards: state.holeCards,
        recentOutcomes: [{ profitBb: -2 }],
        nested: { visible: 'retained' },
      });
      expect(view.modelQuestions).toEqual({ action: questions.action });
      expect(view.context.auditOnlyMarker).toBe('not-sent-to-model');
      expect(view.modelInput).not.toHaveProperty('auditOnlyMarker');
      expect(response.body).not.toMatch(
        /private-history-key|private-turn-token|private-nested-auth|private-question-key|private-request-header|private-extra-header|authorization|api_key|apiKey|turn_token/,
      );
      expect(
        store.db.prepare('SELECT proposal FROM decisions WHERE id=?').get(id)?.proposal,
      ).toContain('private-request-header');
      // A retained request inside an unavailable/fallback proposal is not presented as a Jev success.
      store.db.prepare("UPDATE decisions SET source='unavailable' WHERE id=?").run(id);
      const failed = (await app.inject(url)).json<DecisionView>();
      expect(failed.modelInput).toBeUndefined();
      expect(failed.modelQuestions).toBeUndefined();
    } finally {
      await app.close();
      store.close();
    }
  });
});
