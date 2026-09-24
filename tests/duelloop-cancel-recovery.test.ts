import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureDecisionModel, type DecisionRecord } from 'duelloop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveDecisionCoordinator } from '../src/duelloop/live/coordinator.js';
import { LiveUsageLedger } from '../src/duelloop/live/usage.js';
import { AuditedDecisionModel } from '../src/duelloop/model.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { authorityKey, decisionStateKey } from '../src/runtime/authority.js';
import type { DecisionTask } from '../src/runtime/engine.js';
import type { StoredAction } from '../src/runtime/types.js';
import { Store } from '../src/storage/store.js';
import { pokerState } from './helpers/duelloop-fixture.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'duelloop-cancel-cold-'));
  disposals.push(async () => rmSync(directory, { recursive: true, force: true }));
  const state = pokerState();
  const inner = new FixtureDecisionModel('cancel-cold-fixture', (question) => {
    const score = question.actionId === 'check' ? question.criteria.length - 1 : 0;
    return {
      score,
      confidence: 1,
      probabilities: Object.fromEntries(
        question.criteria.map((_, index) => [index, index === score ? 1 : 0]),
      ),
    };
  });
  function open(runId: string) {
    const raw = new Store(join(directory, 'raw.sqlite'));
    raw.acquireLease();
    raw.beginRun({
      id: runId,
      kind: 'live',
      strategy: 'jev',
      startedAt: new Date().toISOString(),
      config: {},
    });
    const ledger = new LiveUsageLedger(raw, runId, inner.id);
    const model = new AuditedDecisionModel(inner, ledger.finish, {
      onStart: ledger.start,
      onLateResult: ledger.late,
    });
    const coordinator = new LiveDecisionCoordinator({
      raw,
      model,
      databasePath: join(directory, 'sdk.sqlite'),
      scopeId: 'cold-scope',
      actorId: 'hero',
      facts: baselineSnapshot,
      mode: 'simulation',
      state: () => structuredClone(state),
      decisionPolicy: { maxDecisionMs: 5000, executionReserveMs: 500 },
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await coordinator.close();
      raw.close();
    };
    disposals.push(close);
    return { raw, coordinator, close };
  }
  const now = Date.now();
  const task: DecisionTask = {
    key: authorityKey(state),
    stateKey: decisionStateKey(state),
    state: structuredClone(state),
    controller: new AbortController(),
    receivedAt: now,
    decisionDeadlineAt: now + 8000,
    deadlineAt: now + 10_000,
    recovered: false,
    opponents: [],
  };
  return { inner, task, open };
}

describe('cold recovery after a caller-cancelled Score without an execution intent', () => {
  it.each(['artifact', 'event'] as const)(
    'does not retry an unproven cancellation after the SDK decision %s write failed',
    async (failurePoint) => {
      const f = fixture();
      const original = f.inner.score.bind(f.inner);
      const score = vi.spyOn(f.inner, 'score').mockImplementationOnce(async (request) => {
        const response = await original(request);
        f.task.controller.abort();
        return response;
      });
      const first = f.open('before-restart');
      const writeArtifact = first.coordinator.sdk.putArtifact.bind(first.coordinator.sdk);
      const writeEvent = first.coordinator.sdk.appendEvent.bind(first.coordinator.sdk);
      const artifact = vi
        .spyOn(first.coordinator.sdk, 'putArtifact')
        .mockImplementation((kind, value, visibility) => {
          if (failurePoint === 'artifact' && kind === 'decision')
            throw new Error('injected_sdk_artifact_failure');
          return writeArtifact(kind, value, visibility);
        });
      const event = vi
        .spyOn(first.coordinator.sdk, 'appendEvent')
        .mockImplementation((type, scope, data, visibility) => {
          if (failurePoint === 'event' && type === 'decision')
            throw new Error('injected_sdk_event_failure');
          return writeEvent(type, scope, data, visibility);
        });
      const interrupted = await first.coordinator.decide(f.task, 'before-restart', 8000);
      expect(interrupted?.decision.status).toBe('cancelled');
      expect(interrupted?.action).toBeNull();
      expect(score).toHaveBeenCalledTimes(1);
      expect(
        first.coordinator.sdk.events({ types: ['decision', 'decision.cancelled'] }),
      ).toHaveLength(0);
      expect(first.coordinator.sdk.intents()).toHaveLength(0);
      artifact.mockRestore();
      event.mockRestore();
      await first.close();

      const next = f.open('after-restart');
      const restored = await next.coordinator.decide(
        {
          ...f.task,
          controller: new AbortController(),
          recovered: true,
          recoveryDeadlineKnown: true,
        },
        'after-restart',
        8000,
      );
      expect(score).toHaveBeenCalledTimes(1);
      expect(restored?.action).toBeNull();
      expect(restored?.decision.status).toBe('failed');
      expect(restored?.decision.fallbackReason).toMatch(
        /Unfinished model attempt requires reconciliation/,
      );
      expect(next.coordinator.sdk.intents()).toHaveLength(0);
      expect(next.raw.db.prepare('SELECT COUNT(*) AS n FROM framework_calls').get()?.n).toBe(1);
    },
  );

  it.each([false, true])(
    'preserves original decision evidence and model deadline (expired=%s)',
    async (expired) => {
      const f = fixture();
      const original = f.inner.score.bind(f.inner);
      const score = vi.spyOn(f.inner, 'score').mockImplementationOnce(async (request) => {
        const response = await original(request);
        f.task.controller.abort();
        return response;
      });
      const first = f.open('before-restart');
      first.coordinator.rememberTurn(
        f.task.key,
        f.task.state.tableId!,
        f.task.receivedAt!,
        f.task.deadlineAt,
        f.task.decisionDeadlineAt!,
      );
      const cancelled = await first.coordinator.decide(f.task, 'before-restart', 8000);
      expect(cancelled?.decision.status).toBe('cancelled');
      expect(cancelled?.action).toBeNull();
      const old = first.coordinator.sdk.events({ types: ['decision'] })[0]!
        .data as unknown as DecisionRecord;
      expect(old.stopReason).toBe('CANCELLED');
      expect(old.modelDeadline).toBeLessThan(f.task.decisionDeadlineAt!);
      expect(first.coordinator.sdk.intents()).toHaveLength(0);
      expect(first.raw.loadDecisionBlock()).toBeNull();
      await first.close();

      const next = f.open('after-restart');
      const timing = next.coordinator.loadTurn(f.task.key)!;
      expect(timing.decisionDeadlineAt).toBe(f.task.decisionDeadlineAt);
      expect(timing.deadlineAt).toBe(f.task.deadlineAt);
      // The old SDK model cap is earlier than both persisted Runtime deadlines.
      // Moving only the clock proves neither a new process nor the old Runtime value extends it.
      const clock = expired
        ? vi.spyOn(Date, 'now').mockReturnValue(old.modelDeadline! + 1)
        : undefined;
      try {
        const restored = await next.coordinator.decide(
          {
            ...f.task,
            controller: new AbortController(),
            receivedAt: Date.now(),
            recovered: true,
            recoveryDeadlineKnown: true,
          },
          'after-restart',
          8000,
        );
        if (expired) {
          expect(score).toHaveBeenCalledTimes(1);
          expect(restored?.decision.status).toBe('failed');
          expect(restored?.decision.fallbackReason).toMatch(/deadline|MODEL_TIMEOUT/i);
          expect(restored?.action).toBeNull();
          expect(next.coordinator.sdk.intents()).toHaveLength(0);
        } else {
          expect(score).toHaveBeenCalledTimes(2);
          expect(restored?.action?.payload.action).toBe('check');
          expect(restored?.decision.id).not.toBe(cancelled?.decision.id);
          expect(restored?.decision.runId).toBe('after-restart');
          expect(restored?.action?.runId).toBe('after-restart');
          expect(restored?.decision.proposal.framework?.decision.modelDeadline).toBe(
            old.modelDeadline,
          );
          expect(restored?.action?.deadlineAt).toBe(f.task.deadlineAt);
          expect(restored?.decision.proposal.request).toEqual(cancelled?.decision.proposal.request);
          expect(restored?.decision.proposal.attempts).toHaveLength(1);
          expect(restored?.decision.proposal.attempts?.[0]?.id).not.toBe(
            cancelled?.decision.proposal.attempts?.[0]?.id,
          );
          expect(next.raw.loadDecisionBlock()).toBeNull();
          expect(next.coordinator.sdk.intents()).toHaveLength(1);
        }
        const durableOld = next.coordinator.sdk.events({ types: ['decision'] })[0]!
          .data as unknown as DecisionRecord;
        expect(durableOld).toEqual(old);
        expect(next.coordinator.sdk.intent(old.decisionId)).toBeUndefined();
        if (!expired) {
          const action = restored!.action!;
          // The SDK intent exists, but PokerRuntime has not saved the host-ready action yet.
          expect(
            next.raw.db.prepare('SELECT id FROM actions WHERE id=?').get(action.id),
          ).toBeUndefined();
          await next.close();
          const third = f.open('after-second-restart');
          expect(score).toHaveBeenCalledTimes(2);
          const rawAction = third.raw.db
            .prepare('SELECT run_id,payload FROM actions WHERE id=?')
            .get(action.id)!;
          expect(rawAction.run_id).toBe('after-restart');
          expect(JSON.parse(String(rawAction.payload))).toEqual(action.payload);
          const execution = third.raw.db
            .prepare('SELECT payload FROM framework_execution WHERE decision_id=?')
            .get(action.decisionId)!;
          const recovered = JSON.parse(String(execution.payload)) as StoredAction;
          expect(recovered.runId).toBe('after-restart');
          expect(recovered.id).toBe(action.id);
          expect(recovered.payload).toEqual(action.payload);
          expect(recovered.deadlineAt).toBe(action.deadlineAt);
        }
      } finally {
        clock?.mockRestore();
      }
    },
  );
});
