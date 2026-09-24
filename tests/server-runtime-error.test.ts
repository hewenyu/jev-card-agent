import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { publicRuntimeError } from '../src/server/public-runtime-error.js';
import { Store } from '../src/storage/store.js';

describe('public runtime failure messages', () => {
  it.each([
    ['decision_state_changed', 'Bot paused: the decision state changed before submission.'],
    [
      'pending_decision_state_changed',
      'Bot paused: the decision state changed before a pending action could be resent.',
    ],
    ['decision_deadline_elapsed', 'Bot paused: the action deadline elapsed before submission.'],
    ['candidate_no_longer_legal', 'Bot paused: the selected action was no longer legal.'],
  ])('maps %s both during drain and after restart', (reason, message) => {
    expect(publicRuntimeError(reason)).toBe(message);
    expect(publicRuntimeError(`Model decision failed; bot paused: ${reason}`)).toBe(message);
  });

  it.each([
    'Provider HTTP 401; Authorization: Bearer private-credential',
    'decision_state_changed private-credential',
    'Model decision failed; bot paused: private-credential',
    '__proto__',
    'constructor',
  ])('never echoes unknown error details: %s', (error) => {
    expect(publicRuntimeError(error)).toBe(
      'Runtime error. Diagnostic details are available to the operator.',
    );
  });

  it('keeps healthy runtime errors absent', () => {
    expect(publicRuntimeError(null)).toBeNull();
    expect(publicRuntimeError('')).toBeNull();
  });

  it('exposes a persisted pause safely through anonymous dashboard, overview and spectator reads', async () => {
    const store = new Store(':memory:');
    store.saveDecisionBlock({
      runId: 'paused-run',
      decisionId: 'failed-decision',
      reason: 'decision_state_changed',
      createdAt: new Date().toISOString(),
    });
    const app = await buildApp(
      {
        ...loadConfig({}),
        publicHistory: true,
        apiToken: 'private-test-administrator-token',
      },
      { store },
    );
    try {
      const message = 'Bot paused: the decision state changed before submission.';
      for (const path of ['/api/overview', '/api/dashboard?view=overview']) {
        const response = await app.inject(path);
        expect(response.statusCode).toBe(200);
        const data = response.json();
        const overview = data.overview ?? data;
        expect(overview.runtime).toMatchObject({
          running: false,
          status: 'stopped',
          error: message,
        });
        expect(overview.capabilities.canControl).toBe(false);
        expect(response.body).not.toContain('private-test-administrator-token');
      }
      expect(app.controller.spectator.current().runtime.error).toBe(message);
      store.saveDecisionBlock({
        runId: 'paused-run',
        decisionId: 'failed-decision',
        reason: 'Provider error containing private-credential',
        createdAt: new Date().toISOString(),
      });
      const response = await app.inject('/api/dashboard?view=live');
      expect(response.json().overview.runtime.error).toBe(
        'Runtime error. Diagnostic details are available to the operator.',
      );
      expect(response.body).not.toContain('private-credential');
      const control = await app.inject({ method: 'POST', url: '/api/runtime/resume' });
      expect(control.statusCode).toBe(403);
    } finally {
      await app.close();
      store.close();
    }
  });
});
