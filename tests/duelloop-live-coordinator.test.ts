import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureDecisionModel, digest } from 'duelloop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveDecisionCoordinator } from '../src/duelloop/live/coordinator.js';
import { Store } from '../src/storage/store.js';
import { createInitialState } from '../src/core/state.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { authorityKey, decisionStateKey } from '../src/runtime/authority.js';
import type { DecisionTask } from '../src/runtime/engine.js';
import type { PokerState, Proposal } from '../src/core/types.js';
import { AuditedDecisionModel } from '../src/duelloop/model.js';
import { LiveUsageLedger } from '../src/duelloop/live/usage.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function fixture(audit = false) {
  const directory = mkdtempSync(join(tmpdir(), 'poker-live-'));
  const raw = new Store(join(directory, 'raw.sqlite'));
  raw.acquireLease();
  raw.beginRun({
    id: 'run',
    kind: 'live',
    strategy: 'jev',
    startedAt: new Date().toISOString(),
    config: {},
  });
  let state: PokerState = {
    ...createInitialState(),
    tableId: 'table',
    handId: 'hand',
    turnToken: 'private-authority',
    heroSeat: 0,
    actorSeat: 0,
    street: 'preflop',
    holeCards: ['Ah', 'Kd'],
    pot: 30,
    smallBlind: 10,
    bigBlind: 20,
    seats: [
      { seat: 0, name: 'hero', stack: 1980, bet: 20, status: 'active', inHand: true },
      { seat: 1, name: 'villain', stack: 1980, bet: 20, status: 'active', inHand: true },
    ],
    validActions: [{ action: 'check' }, { action: 'fold' }],
  };
  const inner = new FixtureDecisionModel('test-score', (question) => {
    const score = question.actionId === 'check' ? 4 : 0;
    return {
      score,
      confidence: 0.8,
      probabilities: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [String(i), i === score ? 1 : 0]),
      ),
    };
  });
  const ledger = audit ? new LiveUsageLedger(raw, 'run', inner.id) : undefined;
  const model = ledger
    ? new AuditedDecisionModel(inner, ledger.finish, {
        onStart: ledger.start,
        onLateResult: ledger.late,
      })
    : inner;
  const coordinator = new LiveDecisionCoordinator({
    raw,
    databasePath: join(directory, 'sdk.sqlite'),
    actorId: 'stable-account',
    scopeId: 'test-scope',
    model,
    facts: baselineSnapshot,
    state: () => structuredClone(state),
    mode: 'simulation',
  });
  disposals.push(async () => {
    await coordinator.close();
    raw.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = (): DecisionTask => ({
    key: authorityKey(state),
    stateKey: decisionStateKey(state),
    state: structuredClone(state),
    controller: new AbortController(),
    receivedAt: Date.now(),
    decisionDeadlineAt: Date.now() + 8000,
    deadlineAt: Date.now() + 10000,
    recovered: false,
    opponents: [],
  });
  return {
    raw,
    model,
    coordinator,
    task,
    get state() {
      return state;
    },
    setState(value: PokerState) {
      state = value;
    },
    directory,
  };
}

describe('single production DuelLoop decision lifecycle', () => {
  it('recovers only the original decision attempts after shared memory is cleared', async () => {
    const f = fixture(true);
    const result = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(result?.action).not.toBeNull();
    const attempts = result!.decision.proposal.attempts!;
    expect(attempts).toHaveLength(1);
    expect((f.model as AuditedDecisionModel).attempts).toHaveLength(0);
    const call = f.raw.db.prepare('SELECT * FROM framework_calls').get()!;
    expect(call.context_id).toBeTruthy();
    f.raw.db
      .prepare(
        'INSERT INTO framework_calls(request_id,reservation_id,started,result,context_id) VALUES(?,?,?,?,?)',
      )
      .run(
        'another-turn',
        String(call.reservation_id),
        String(call.started),
        JSON.stringify({ ...JSON.parse(String(call.result)), requestId: 'another-turn' }),
        'unrelated-context',
      );
    f.raw.db.prepare('DELETE FROM framework_cursors').run();
    f.coordinator.recoverProjections();
    const recovered = JSON.parse(
      String(
        f.raw.db.prepare('SELECT proposal FROM decisions WHERE id=?').get(result!.decision.id)!
          .proposal,
      ),
    ) as Proposal;
    expect(recovered.attempts).toEqual(attempts);
    expect(recovered.attempts!.map((attempt) => attempt.id)).not.toContain('another-turn');
  });
  it('calls Score, persists the release and intent, and emits the exact SDK id without authority in model features', async () => {
    const f = fixture();
    const score = vi.spyOn(f.model, 'score');
    const task = f.task();
    f.coordinator.pin(task.state, new Date(task.receivedAt!).toISOString());
    const result = await f.coordinator.decide(task, 'run', 8000);
    expect(result?.decision.status, result?.decision.fallbackReason ?? '').toBe('proposed');
    expect(score).toHaveBeenCalledTimes(1);
    expect(result?.action?.payload).toMatchObject({
      action: 'check',
      client_action_id: result?.decision.id,
      turn_token: 'private-authority',
    });
    const record = result!.decision.proposal.framework!.decision;
    expect(record.observation.deadline).toBe(task.deadlineAt);
    expect(record.modelDeadline).toBeLessThan(task.deadlineAt);
    expect(record.releaseDigest).toBe(f.coordinator.sdk.activeRelease('test-scope'));
    expect(f.coordinator.sdk.intent(record.decisionId)).toBeDefined();
    const input = JSON.stringify(score.mock.calls[0]![0].state);
    expect(input).not.toContain('private-authority');
    expect(input).not.toContain('approvedAdvice');
    expect(input).not.toContain('uniformShowdownReference');
    expect(input).not.toContain('adjustmentHypothesis');
    expect(record.answers).not.toEqual(record.probabilities);
    f.coordinator.bridge.store.saveDecision(result!.decision);
    f.coordinator.bridge.store.prepareAction(result!.action!);
    f.coordinator.beforeSend(result!.action!, f.state);
    expect(f.raw.db.prepare('SELECT state FROM framework_execution').get()?.state).toBe(
      'possibly_sent',
    );
    f.coordinator.bridge.store.appendEvent(
      'run',
      {
        type: 'action_ack',
        status: 'accepted',
        client_action_id: result!.action!.id,
        table_id: 'table',
        hand_id: 'hand',
      },
      new Date().toISOString(),
    );
    expect(f.coordinator.sdk.intent(record.decisionId)?.receipt?.status).toBe('completed');
    expect(f.coordinator.sdk.unresolvedIntents('test-scope')).toHaveLength(0);
  });

  it('reuses a saved decision after projection loss without another model request', async () => {
    const f = fixture();
    const task = f.task();
    const score = vi.spyOn(f.model, 'score');
    vi.spyOn(f.coordinator.runtime, 'prepareHostExecution').mockRejectedValueOnce(
      new Error('crash_before_intent'),
    );
    const first = await f.coordinator.decide(task, 'run', 8000);
    expect(first?.action).toBeNull();
    expect(f.coordinator.sdk.intents()).toHaveLength(0);
    f.raw.db.prepare('DELETE FROM framework_decisions').run();
    f.raw.db.prepare('DELETE FROM framework_cursors').run();
    f.coordinator.recoverProjections();
    const second = await f.coordinator.decide(task, 'run', 8000);
    expect(second?.action?.id).toBe(first?.decision.id);
    expect(score).toHaveBeenCalledTimes(1);
    expect(second?.decision.proposal.framework?.decision.decisionSource).toBe('strategy');
  });

  it('does not fabricate a new action while an intent remains unresolved', async () => {
    const f = fixture();
    const score = vi.spyOn(f.model, 'score');
    const first = await f.coordinator.decide(f.task(), 'run', 8000);
    const next = { ...f.state, turnToken: 'next-turn' };
    f.setState(next);
    const second = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(first?.action).not.toBeNull();
    expect(second?.action).toBeNull();
    expect(second?.decision.fallbackReason).toContain('Unresolved SDK execution');
    expect(score).toHaveBeenCalledTimes(1);
  });

  it('cancels one obsolete task without poisoning the next hand', async () => {
    const f = fixture();
    const original = f.model.score.bind(f.model);
    const task = f.task();
    vi.spyOn(f.model, 'score').mockImplementationOnce(async (request) => {
      task.controller.abort();
      request.signal.throwIfAborted();
      return original(request);
    });
    const cancelled = await f.coordinator.decide(task, 'run', 8000);
    expect(cancelled?.decision.status, cancelled?.decision.fallbackReason ?? '').toBe('cancelled');
    expect(cancelled?.action).toBeNull();
    f.setState({ ...f.state, handId: 'next-hand', turnToken: 'next-token' });
    const next = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(next?.decision.status).toBe('proposed');
    expect(next?.action?.payload.action).toBe('check');
  });

  it('rejects changed prices/state after scoring without sending or silently substituting', async () => {
    const f = fixture();
    const original = f.model.score.bind(f.model);
    vi.spyOn(f.model, 'score').mockImplementationOnce(async (request) => {
      const answer = await original(request);
      f.setState({ ...f.state, pot: 500 });
      return answer;
    });
    const result = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(result?.action).toBeNull();
    expect(result?.decision.status).toBe('failed');
    expect(f.coordinator.sdk.intents()).toHaveLength(0);
  });

  it('persists original turn deadlines and immutable facts digest across recovery', async () => {
    const f = fixture();
    const task = f.task();
    f.coordinator.rememberTurn(
      task.key,
      'table',
      task.receivedAt!,
      task.deadlineAt,
      task.decisionDeadlineAt!,
    );
    f.coordinator.rememberTurn(
      task.key,
      'table',
      Date.now() + 1000,
      task.deadlineAt + 1000,
      task.decisionDeadlineAt! + 1000,
    );
    expect(f.coordinator.loadTurn(task.key)).toMatchObject({
      deadlineAt: task.deadlineAt,
      decisionDeadlineAt: task.decisionDeadlineAt,
    });
    const binding = f.coordinator.bindings.pin(
      task.state,
      new Date(task.receivedAt!).toISOString(),
    );
    expect(binding.factsSnapshotDigest).toBe(digest(binding.facts));
    expect(binding.facts).not.toHaveProperty('cards');
    expect(binding.streamId).not.toContain('run');
  });
});
