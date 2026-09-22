import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { createInitialState } from '../src/core/state.js';
import type { AuditView, SlowLoopStatus } from '../src/knowledge/types.js';
import type { DecisionView } from '../src/shared/api.js';

describe('public asynchronous decision evidence', () => {
  it('publishes worker status in both anonymous overview and SSE snapshots without internal fields or errors', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(
      {
        ...loadConfig({}, true),
        publicHistory: true,
        apiToken: 'test-only-private-control-token-long',
      },
      { store },
    );
    try {
      const status = {
        enabled: true,
        running: true,
        lastCompletedAt: '2026-01-01T00:00:00.000Z',
        eventCursor: 50,
        decisionCursor: 30,
        pendingHands: 4,
        pendingAudits: 2,
        latestVersion: 'poker-knowledge-v1-e50',
        error: 'private worker diagnostic',
        privateEnv: 'private worker credential',
      };
      vi.spyOn(app.controller.research, 'status').mockReturnValue(status);
      const response = await app.inject('/api/overview');
      const research = response.json().runtime.research;
      expect(research).toEqual({
        enabled: true,
        running: true,
        lastCompletedAt: status.lastCompletedAt,
        eventCursor: 50,
        decisionCursor: 30,
        pendingHands: 4,
        pendingAudits: 2,
        latestVersion: status.latestVersion,
        error: 'Knowledge worker unavailable',
      });
      expect(response.body).not.toContain('private worker');
      app.controller.spectator.update(app.controller.view());
      expect(app.controller.spectator.current().runtime.research).toEqual(research);
      status.error = '';
      expect((await app.inject('/api/overview')).json().runtime.research.error).toBeNull();
    } finally {
      await app.close();
      store.close();
    }
  });
  it('adds audit and timings without rewriting the saved model request or frozen context', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(
      {
        ...loadConfig({}, true),
        publicHistory: true,
        apiToken: 'test-only-private-control-token-long',
      },
      { store },
    );
    try {
      const id = 'demo-jev-hand-1-flop';
      const url = `/api/decisions/${id}`;
      expect((await app.inject(url)).json<DecisionView>().audit).toBeUndefined();
      const binding = store.pinKnowledge(
        { ...createInitialState(), tableId: 'demo-table-jev', handId: 'demo-jev-hand-1' },
        new Date().toISOString(),
      );
      const { opponents: _opponents, cards: _cards, ...metadata } = binding.snapshot;
      const row = store.db.prepare('SELECT context,proposal FROM decisions WHERE id=?').get(id)!;
      const context = JSON.stringify({
        ...JSON.parse(String(row.context)),
        knowledge: { pin: binding.pin, snapshot: metadata },
      });
      const proposal = {
        ...JSON.parse(String(row.proposal)),
        request: {
          state: { savedInput: 'actual-request' },
          questions: { action: { type: 'choice' } },
        },
      };
      store.db
        .prepare('UPDATE decisions SET context=?,proposal=? WHERE id=?')
        .run(context, JSON.stringify(proposal), id);
      store.saveDecisionTiming(id, {
        receivedAt: '2026-01-01T00:00:00.000Z',
        preparationStartedAt: '2026-01-01T00:00:00.001Z',
        preparationMs: 5,
        knowledgeMs: 1,
        providerMs: 450,
        persistenceMs: 2,
        receiptToSendMs: 458,
        ackMs: 30,
      });
      let audit: AuditView | null = null;
      const status: SlowLoopStatus = {
        enabled: true,
        running: true,
        lastCompletedAt: null,
        eventCursor: 0,
        decisionCursor: 0,
        pendingHands: 0,
        pendingAudits: 1,
        latestVersion: binding.pin.knowledgeVersion,
        error: null,
      };
      store.knowledgeSource = {
        latest: baselineSnapshot,
        status: () => status,
        getAudit: () => audit,
      };
      const pending = (await app.inject(url)).json<DecisionView>();
      expect(pending.audit?.status).toBe('pending');
      expect(pending.timing).toMatchObject({ providerMs: 450, receiptToSendMs: 458, ackMs: 30 });
      audit = {
        decisionId: id,
        inputHash: createHash('sha256').update(context).digest('hex'),
        computedAt: new Date().toISOString(),
        status: 'unavailable',
        uniformShowdownReference: null,
        provenance: 'asynchronous_audit_not_model_input',
      };
      const completed = (await app.inject(url)).json<DecisionView>();
      expect(completed.audit?.status).toBe('unavailable');
      expect(completed.modelInput).toEqual(pending.modelInput);
      expect(completed.context).toEqual(pending.context);
      expect(store.db.prepare('SELECT context FROM decisions WHERE id=?').get(id)?.context).toBe(
        context,
      );
      audit = null;
      status.error = 'Worker failure';
      expect((await app.inject(url)).json<DecisionView>().audit?.status).toBe('failed');
      status.enabled = false;
      expect((await app.inject(url)).json<DecisionView>().audit?.status).toBe('disabled');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/runtime/start',
            payload: { strategy: 'jev' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
      store.close();
    }
  });
});
