import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureDecisionModel, digest } from 'duelloop';
import { createPokerStrategy } from '../src/poker/strategy.js';
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
  const createCoordinator = () =>
    new LiveDecisionCoordinator({
      raw,
      databasePath: join(directory, 'sdk.sqlite'),
      actorId: 'stable-account',
      scopeId: 'test-scope',
      model,
      facts: baselineSnapshot,
      state: () => structuredClone(state),
      mode: 'simulation',
    });
  let coordinator = createCoordinator();
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
    get coordinator() {
      return coordinator;
    },
    async reopen() {
      await coordinator.close();
      coordinator = createCoordinator();
    },
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
    await f.coordinator.pin(task.state, new Date(task.receivedAt!).toISOString());
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

/** Synthetic validation reports exercise SDK gates; they are not poker performance evidence. */
function pendingCandidate(
  f: ReturnType<typeof fixture>,
  id: string,
  options: { status?: string; base?: string; modelKind?: string } = {},
) {
  const { sdk, runtime } = f.coordinator;
  const base = options.base ?? sdk.activeRelease('test-scope')!;
  const strategy = createPokerStrategy();
  strategy.version = id;
  strategy.questions[0]!.instructions += `\nSynthetic research marker: ${id}`;
  const strategyDigest = sdk.putArtifact('strategy', strategy);
  const run = sdk.createRun({
    id,
    scopeId: 'test-scope',
    baseReleaseDigest: base,
    researchSnapshotId: sdk.snapshot('test-scope', Date.now()),
    evaluationProtocolDigest: sdk.putArtifact('protocol', { id }, 'private'),
    status: 'created',
    data: {},
  });
  sdk.transitionRun(run.id, ['created'], 'researching');
  sdk.transitionRun(run.id, ['researching'], 'candidate_locked');
  sdk.transitionRun(run.id, ['candidate_locked'], 'final_evaluating');
  sdk.transitionRun(run.id, ['final_evaluating'], 'completed_passed');
  const validationDigest = sdk.putArtifact(
    'validation_report',
    {
      candidateDigest: strategyDigest,
      baseReleaseDigest: base,
      dependencies: runtime.dependencies,
      status: options.status ?? 'passed',
      stage: 'final',
      modelKind: options.modelKind ?? 'fixture',
    },
    'private',
  );
  return sdk.registerRelease({
    strategyDigest,
    dependencies: runtime.dependencies,
    scopeId: 'test-scope',
    expectedActiveDigest: base,
    validationDigest,
    source: 'research',
    researchRunId: run.id,
  });
}

function acceptAction(
  f: ReturnType<typeof fixture>,
  result: NonNullable<Awaited<ReturnType<typeof f.coordinator.decide>>>,
) {
  f.coordinator.bridge.store.saveDecision(result.decision);
  f.coordinator.bridge.store.prepareAction(result.action!);
  f.coordinator.beforeSend(result.action!, f.state);
  f.coordinator.bridge.store.appendEvent(
    'run',
    {
      type: 'action_ack',
      status: 'accepted',
      client_action_id: result.action!.id,
      table_id: f.state.tableId!,
      hand_id: f.state.handId!,
    },
    new Date().toISOString(),
  );
}

describe('automatic validated strategy activation at an unbound hand', () => {
  it('does not activate or pin when the lease is lost after enqueueing the hand', async () => {
    const f = fixture();
    const original = f.coordinator.sdk.activeRelease('test-scope');
    pendingCandidate(f, 'lost-lease-before-queue-execution');
    const activate = vi.spyOn(f.coordinator.runtime, 'activatePending');
    const pending = f.coordinator.pin(f.state, new Date().toISOString());
    f.raw.releaseLease();
    await expect(pending).rejects.toThrow('Runtime database lease is not owned or has expired');
    expect(activate).not.toHaveBeenCalled();
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
    expect(f.raw.db.prepare('SELECT COUNT(*) n FROM framework_hands').get()?.n).toBe(0);
  });

  it('does not persist a hand binding if the lease is lost during activation', async () => {
    const f = fixture();
    const next = pendingCandidate(f, 'lost-lease-after-activation');
    const activate = f.coordinator.runtime.activatePending.bind(f.coordinator.runtime);
    vi.spyOn(f.coordinator.runtime, 'activatePending').mockImplementationOnce(async (scope) => {
      const activated = await activate(scope);
      f.raw.releaseLease();
      return activated;
    });
    await expect(f.coordinator.pin(f.state, new Date().toISOString())).rejects.toThrow(
      'Runtime database lease is not owned or has expired',
    );
    // The committed release remains visible; a lost owner cannot create any hand binding.
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(next);
    expect(f.raw.db.prepare('SELECT COUNT(*) n FROM framework_hands').get()?.n).toBe(0);
    const identity = f.coordinator.bindings.identity(f.state);
    expect(
      f.coordinator.runtime.lookupTrajectoryRelease({
        ...identity,
        strategyScopeId: identity.scopeId,
      }),
    ).toBeUndefined();
  });

  it('keeps the current hand after publication and restart, then changes actual Jev questions on the next hand', async () => {
    const f = fixture();
    const at = new Date().toISOString();
    await f.coordinator.pin(f.state, at);
    const original = f.coordinator.sdk.activeRelease('test-scope');
    const next = pendingCandidate(f, 'new-reviewed-guidance');
    await f.reopen();
    await f.coordinator.pin(f.state, at);
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
    const current = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(current?.action).toBeTruthy();
    expect(JSON.stringify(current!.decision.proposal.request)).not.toContain(
      'new-reviewed-guidance',
    );
    acceptAction(f, current!);
    f.setState({ ...f.state, handId: 'next-hand', turnToken: 'next-turn' });
    // The real hand_start hook can run without an immediate await; capture waits for its queue.
    const queued = f.coordinator.pin(f.state, new Date().toISOString());
    const result = await f.coordinator.decide(f.task(), 'run', 8000);
    await queued;
    expect(result?.decision.proposal.framework?.decision.releaseDigest).toBe(next);
    expect(JSON.stringify(result!.decision.proposal.request)).toContain('new-reviewed-guidance');
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(next);
    expect(
      f.raw.db
        .prepare('SELECT release FROM framework_hands WHERE trajectory=?')
        .get(JSON.stringify(['table', 'hand']))?.release,
    ).toBe(original);
  });

  it('activates before decision capture when hand_start was unavailable', async () => {
    const f = fixture();
    const next = pendingCandidate(f, 'capture-only');
    const result = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(result?.decision.proposal.framework?.decision.releaseDigest).toBe(next);
    expect(JSON.stringify(result?.decision.proposal.request)).toContain('capture-only');
  });

  it('recovers a partially persisted host binding without changing its expected release', async () => {
    const f = fixture();
    const original = f.coordinator.sdk.activeRelease('test-scope');
    vi.spyOn(f.coordinator.runtime, 'pinTrajectory').mockImplementationOnce(() => {
      throw new Error('crash before SDK pin');
    });
    await expect(f.coordinator.pin(f.state, new Date().toISOString())).rejects.toThrow(
      'crash before SDK pin',
    );
    pendingCandidate(f, 'must-wait-for-new-hand');
    await f.reopen();
    await f.coordinator.pin(f.state, new Date().toISOString());
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
    expect(f.raw.db.prepare('SELECT release FROM framework_hands').get()?.release).toBe(original);
  });

  it('preserves an SDK-only pin and refuses to invent missing original facts', async () => {
    const f = fixture();
    const identity = f.coordinator.bindings.identity(f.state);
    const original = f.coordinator.runtime.pinTrajectory({
      ...identity,
      strategyScopeId: identity.scopeId,
    });
    pendingCandidate(f, 'sdk-only-binding');
    await expect(f.coordinator.pin(f.state, new Date().toISOString())).rejects.toThrow(
      'no recoverable original facts',
    );
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
    expect(f.raw.db.prepare('SELECT COUNT(*) n FROM framework_hands').get()?.n).toBe(0);
  });

  it.each(['failed', 'inconclusive'])(
    'rejects %s final validation without changing the active strategy',
    async (status) => {
      const f = fixture();
      const original = f.coordinator.sdk.activeRelease('test-scope');
      pendingCandidate(f, `validation-${status}`, { status });
      await f.coordinator.pin(f.state, new Date().toISOString());
      expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
      expect(f.coordinator.sdk.events({ types: ['release.invalid'] })[0]?.data).toMatchObject({
        reason: 'VALIDATION_REJECTED',
      });
    },
  );

  it('honors activation pause and does not retroactively change the hand pinned while paused', async () => {
    const f = fixture();
    const original = f.coordinator.sdk.activeRelease('test-scope');
    const next = pendingCandidate(f, 'paused-candidate');
    f.coordinator.sdk.pauseActivation('test-scope', true);
    await f.coordinator.pin(f.state, new Date().toISOString());
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
    f.coordinator.sdk.pauseActivation('test-scope', false);
    await f.coordinator.pin(f.state, new Date().toISOString());
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
    await f.coordinator.pin({ ...f.state, handId: 'after-unpause' }, new Date().toISOString());
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(next);
  });

  it.each(['explicit', 'candidate_only'] as const)('respects %s mode', async (mode) => {
    const f = fixture();
    const original = f.coordinator.sdk.activeRelease('test-scope');
    pendingCandidate(f, mode);
    f.coordinator.sdk.setActivationMode('test-scope', mode);
    await f.coordinator.pin(f.state, new Date().toISOString());
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
  });

  it('does not activate a stale candidate after another release changed the baseline', async () => {
    const f = fixture();
    const first = pendingCandidate(f, 'first');
    const stale = pendingCandidate(f, 'stale');
    await f.coordinator.runtime.activate(first, true);
    await f.coordinator.pin(f.state, new Date().toISOString());
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(first);
    expect(
      f.coordinator.sdk.scopeStatus('test-scope').releases.find((r) => r.digest === stale)
        ?.blockers,
    ).toContain('baseline_changed');
  });

  it('does not activate while an old execution intent remains unresolved', async () => {
    const f = fixture();
    const original = f.coordinator.sdk.activeRelease('test-scope');
    const result = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(result?.action).toBeTruthy();
    pendingCandidate(f, 'unresolved-intent');
    f.setState({ ...f.state, handId: 'blocked-hand', turnToken: 'blocked-turn' });
    await f.coordinator.pin(f.state, new Date().toISOString());
    expect(f.coordinator.sdk.activeRelease('test-scope')).toBe(original);
    const blocked = await f.coordinator.decide(f.task(), 'run', 8000);
    expect(blocked?.action).toBeNull();
    expect(blocked?.decision.fallbackReason).toContain('Unresolved SDK execution');
  });
});
