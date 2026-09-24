import { randomUUID } from 'node:crypto';
import {
  DuelLoop,
  DuelLoopError,
  SqliteStore,
  digest,
  buildQuestions,
  type StrategyPackage,
  type DecisionModel,
  type DecisionRecord as SdkDecision,
} from 'duelloop';
import { buildCandidates, validateCandidate } from '../../core/index.js';
import type { DecisionContext, PokerState } from '../../core/types.js';
import type { DecisionTask, RuntimeDecisionEngine } from '../../runtime/engine.js';
import type { DecisionRecord, StoredAction } from '../../runtime/types.js';
import type { DecisionTiming } from '../../runtime/timing.js';
import type { LiveDecisionProgress } from '../../shared/api.js';
import { decisionStateKey, actionAuthorityKey } from '../../runtime/authority.js';
import type { Store } from '../../storage/store.js';
import type { KnowledgeSnapshot } from '../../knowledge/types.js';
import { buildPokerInput } from '../../poker/input.js';
import { buildPokerContext } from '../../poker/context.js';
import {
  createPokerDomain,
  POKER_APPLICATION_ID,
  POKER_DECISION_POLICY,
} from '../../poker/domain.js';
import { createPokerStrategy } from '../../poker/strategy.js';
import { HostJournal } from '../host/journal.js';
import { HostBridge } from '../host/bridge.js';
import { HandBindings, type HandBinding } from './bindings.js';
import { withModelDeadline } from './model.js';
import { providerAttempt } from './usage.js';
import type { AuditedDecisionModel, ModelAttempt } from '../model.js';
import { DecisionAttempts } from './attempts.js';

interface Capture {
  runId: string;
  context: DecisionContext;
  state: PokerState;
  binding: HandBinding;
  timing: DecisionTiming;
}

/** One durable SDK lifecycle per authorized runtime, with no legacy policy/advice invocation. */
export class LiveDecisionCoordinator implements RuntimeDecisionEngine {
  readonly sdk: SqliteStore;
  readonly runtime: DuelLoop;
  readonly journal: HostJournal;
  readonly bindings: HandBindings;
  readonly bridge: HostBridge;
  readonly attempts: DecisionAttempts;
  private current?: { task: DecisionTask; capture: Capture };
  private readonly decisions = new Map<string, ReturnType<RuntimeDecisionEngine['decide']>>();

  constructor(
    readonly options: {
      raw: Store;
      databasePath: string;
      scopeId: string;
      actorId: string;
      model: DecisionModel;
      state: () => PokerState;
      facts: (asOf: string) => KnowledgeSnapshot;
      decisionPolicy?: typeof POKER_DECISION_POLICY;
      mode?: 'live' | 'simulation';
    },
  ) {
    this.journal = new HostJournal(options.raw.db);
    options.raw.db.exec(`CREATE TABLE IF NOT EXISTS framework_contexts (
      scope TEXT NOT NULL, stream TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(scope,stream,revision));`);
    this.sdk = new SqliteStore(options.databasePath);
    this.attempts = new DecisionAttempts(this.journal.db, this.sdk);
    const domain = createPokerDomain({
      observe: async (stream) => {
        const current = this.current;
        if (
          !current ||
          current.capture.binding.streamId !== stream ||
          current.task.controller.signal.aborted
        )
          throw new Error('No current host action authority');
        return this.input(current.task, current.capture, options.state()).observation;
      },
      candidates: async (observation) => {
        if (!this.current) throw new Error('No current host action authority');
        const input = this.input(this.current.task, this.current.capture, options.state());
        if (input.observation.revision !== observation.revision)
          throw new Error('Candidate state changed');
        return input.candidates;
      },
    });
    this.runtime = new DuelLoop({
      applicationId: POKER_APPLICATION_ID,
      domain,
      store: this.sdk,
      model: options.model,
      executionOwner: 'host',
      mode: options.mode ?? 'live',
      ...(options.decisionPolicy ?? POKER_DECISION_POLICY),
    });
    if (!this.sdk.activeRelease(options.scopeId)) {
      this.sdk.setActivationMode(options.scopeId, 'explicit');
      this.runtime.bootstrap(createPokerStrategy(), options.scopeId);
    }
    this.bindings = new HandBindings(
      this.journal,
      this.runtime,
      options.scopeId,
      options.actorId,
      options.facts,
    );
    this.bridge = new HostBridge(options.raw, this.journal, this.sdk, this.runtime, this.bindings);
    this.recoverProjections();
    this.recoverPreparedActions();
    this.bridge.flushReceipts();
  }

  pin(state: PokerState, at: string): void {
    this.bindings.pin(state, at);
  }

  rememberTurn(
    key: string,
    tableId: string,
    receivedAt: number,
    deadlineAt: number,
    decisionDeadlineAt: number,
  ): void {
    this.journal.db
      .prepare('INSERT OR IGNORE INTO framework_turns VALUES(?,?,?,?,?)')
      .run(key, tableId, receivedAt, deadlineAt, decisionDeadlineAt);
  }

  loadTurn(key: string) {
    const row = this.journal.db.prepare('SELECT * FROM framework_turns WHERE authority=?').get(key);
    return row
      ? {
          tableId: String(row.table_id),
          receivedAt: Number(row.received_at),
          deadlineAt: Number(row.authority_deadline),
          decisionDeadlineAt: Number(row.model_deadline),
        }
      : undefined;
  }

  private input(task: DecisionTask, capture: Capture, state = task.state) {
    const input = buildPokerInput(capture.context, buildCandidates(state), {
      ...capture.binding,
      revision: decisionStateKey(state),
      observedAt: Date.parse(capture.timing.receivedAt),
      authorityDeadline: task.deadlineAt,
    });
    input.observation.deadline = this.attempts.authorityDeadline(input.observation);
    return input;
  }

  private capture(task: DecisionTask, runId: string): Capture {
    const started = Date.now();
    const at = new Date(task.receivedAt ?? started).toISOString();
    const binding = this.bindings.pin(task.state, at);
    const context = buildPokerContext(task.state, {
      asOf: binding.facts.cutoff,
      opponentMemory: binding.facts.opponents,
      previousTurns: this.options.raw.sessionTurns(
        task.state.tableId!,
        task.state.handId!,
        at,
        task.state.lastTableSeq,
      ),
    });
    context.framework = {
      engine: 'duelloop',
      releaseDigest: binding.releaseDigest,
      factsSnapshotDigest: binding.factsSnapshotDigest,
      evidenceCutoff: binding.facts.cutoff,
    };
    const capture = {
      runId,
      context,
      state: task.state,
      binding,
      timing: {
        receivedAt: at,
        preparationStartedAt: new Date(started).toISOString(),
        preparationMs: Date.now() - (task.receivedAt ?? started),
        knowledgeMs: Date.now() - started,
        providerMs: 0,
        persistenceMs: 0,
      },
    };
    const revision = decisionStateKey(task.state);
    const previous = this.journal.db
      .prepare('SELECT payload FROM framework_contexts WHERE scope=? AND stream=? AND revision=?')
      .get(binding.scopeId, binding.streamId, revision);
    if (previous) return JSON.parse(String(previous.payload)) as Capture;
    this.journal.db
      .prepare('INSERT INTO framework_contexts VALUES(?,?,?,?)')
      .run(binding.scopeId, binding.streamId, revision, JSON.stringify(capture));
    return capture;
  }

  async decide(
    task: DecisionTask,
    runId: string,
    budgetMs: number,
    progress?: (progress: LiveDecisionProgress) => void,
  ) {
    const key = decisionStateKey(task.state);
    const previous = this.decisions.get(key);
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      return this.decideOnce(task, runId, budgetMs, progress);
    })();
    this.decisions.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.decisions.get(key) === operation) this.decisions.delete(key);
    }
  }

  private async decideOnce(
    task: DecisionTask,
    runId: string,
    _budgetMs: number,
    progress?: (progress: LiveDecisionProgress) => void,
  ) {
    if (!task.state.tableId || !task.state.handId || !task.state.turnToken) return null;
    this.options.raw.assertRuntimeLease();
    await this.bridge.flush();
    const capture = this.capture(task, runId);
    this.current = { task, capture };
    const input = this.input(task, capture);
    const policy = this.options.decisionPolicy ?? POKER_DECISION_POLICY;
    const proposedModelDeadline = Math.min(
      task.decisionDeadlineAt ?? task.deadlineAt - policy.executionReserveMs,
      task.deadlineAt - policy.executionReserveMs,
      Date.now() + policy.maxDecisionMs - policy.executionReserveMs,
    );
    progress?.({
      id: 'sdk-pending',
      sessionId: capture.context.session!.id,
      tableId: task.state.tableId,
      handId: task.state.handId,
      phase: 'jev',
      startedAt: capture.timing.receivedAt,
      updatedAt: new Date().toISOString(),
    });
    let sdkDecision: SdkDecision | undefined;
    let attemptId: string | undefined;
    try {
      if (task.recovered && !task.recoveryDeadlineKnown)
        throw new Error('recovered_turn_unknown_remaining_time');
      task.controller.signal.throwIfAborted();
      this.bridge.assertNoUnknown(capture.binding.streamId);
      const previous = this.existingDecision(input.observation.revision, capture.binding.streamId);
      const window = this.attempts.window(input.observation, proposedModelDeadline, previous);
      input.observation.deadline = window.authorityDeadline;
      if (Date.now() >= window.authorityDeadline) throw new Error('action_deadline_elapsed');
      if (previous && !this.attempts.mayRetry(previous)) sdkDecision = previous;
      if (!sdkDecision) {
        if (Date.now() >= window.modelDeadline) throw new Error('decision_deadline_elapsed');
        if (decisionStateKey(this.options.state()) !== input.observation.revision)
          throw new Error('decision_state_changed');
        this.options.raw.assertRuntimeLease();
        attemptId = this.attempts.begin(input.observation, runId);
        sdkDecision = await withModelDeadline(
          window.modelDeadline,
          () =>
            this.runtime.decide(input.observation, input.candidates, {
              signal: task.controller.signal,
              modelDeadline: window.modelDeadline,
            }),
          attemptId,
        );
        this.recoverProjections();
      }
      if (sdkDecision.decisionSource !== 'strategy' || !sdkDecision.action)
        throw new Error(sdkDecision.stopReason ?? 'model_decision_unavailable');
      const decision = this.project(sdkDecision, capture);
      this.journal.decision(sdkDecision, decision.runId);
      task.controller.signal.throwIfAborted();
      const candidate = buildCandidates(task.state).find(
        (item) => item.id === sdkDecision!.action!.id,
      );
      if (!candidate || !validateCandidate(candidate, this.options.state()))
        throw new Error('candidate_no_longer_legal');
      const intent = this.sdk.intent(sdkDecision.decisionId);
      if (intent) throw new Error('Existing execution intent requires reconciliation');
      const command = await this.runtime.prepareHostExecution(sdkDecision);
      const action: StoredAction = {
        id: command.idempotencyKey,
        decisionId: sdkDecision.decisionId,
        runId: decision.runId,
        tableId: task.state.tableId,
        status: 'prepared',
        createdAt: new Date().toISOString(),
        deadlineAt: command.deadline,
        stateKey: decisionStateKey(task.state, false),
        decisionSource: 'jev',
        timing: decision.timing,
        payload: {
          type: 'action',
          action: candidate.action,
          ...(candidate.action === 'raise' ? { amount: candidate.amount } : {}),
          hand_id: task.state.handId,
          turn_token: task.state.turnToken,
          client_action_id: command.idempotencyKey,
        },
      };
      return { decision, action };
    } catch (error) {
      this.recoverProjections();
      const recordedId = attemptId ? this.attempts.decisionId(attemptId) : undefined;
      if (recordedId) sdkDecision = this.journal.getDecision(recordedId);
      // Without a durable SDK outcome, the attempt remains unresolved even if the
      // caller aborted. A simultaneous storage failure is not proof of cancellation.
      const decision = sdkDecision
        ? this.project(sdkDecision, capture)
        : this.failure(capture, error, runId);
      decision.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
      decision.fallbackReason = task.controller.signal.aborted
        ? 'decision_cancelled'
        : error instanceof DuelLoopError
          ? error.code
          : error instanceof Error
            ? error.message
            : 'decision_failed';
      decision.proposal = {
        ...decision.proposal,
        source: 'unavailable',
        candidateId: '',
        selected: '',
        explanation: 'No valid Jev action was submitted; execution remains stopped.',
      };
      return { decision, action: null };
    } finally {
      if (this.current?.task === task) {
        this.current = undefined;
        const audited = this.options.model as Partial<AuditedDecisionModel>;
        audited.attempts?.splice(0);
        audited.lateResults?.splice(0);
      }
    }
  }

  private existingDecision(revision: string, stream: string): SdkDecision | undefined {
    this.recoverProjections();
    const row = this.journal.db
      .prepare(
        "SELECT payload FROM framework_decisions WHERE json_extract(payload,'$.observation.strategyScopeId')=? AND json_extract(payload,'$.observation.streamId')=? AND json_extract(payload,'$.observation.revision')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(this.options.scopeId, stream, revision);
    return row ? (JSON.parse(String(row.payload)) as SdkDecision) : undefined;
  }

  private project(record: SdkDecision, capture: Capture): DecisionRecord {
    const context = structuredClone(capture.context);
    if (context.session) context.session.decisionId = record.decisionId;
    const strategy = this.sdk.getArtifact<StrategyPackage>(record.strategyDigest);
    const request = buildQuestions(
      strategy,
      record.observation,
      record.candidates,
      this.runtime.domain,
    );
    const contextId = this.attempts.callsContext(record);
    const hasLedger = this.journal.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='framework_calls'")
      .get();
    const requestHash = digest({ model: this.options.model.id, ...request });
    const attempts: ModelAttempt[] = hasLedger
      ? this.journal.db
          .prepare(
            'SELECT result FROM framework_calls WHERE context_id=? AND result IS NOT NULL ORDER BY rowid',
          )
          .all(contextId)
          .map((row) => JSON.parse(String(row.result)) as ModelAttempt)
      : ((this.options.model as Partial<AuditedDecisionModel>).attempts ?? []).filter(
          (attempt) =>
            attempt.requestHash === requestHash &&
            Date.parse(attempt.startedAt) >= record.startedAt &&
            Date.parse(attempt.startedAt) <= record.finishedAt,
        );
    return {
      id: record.decisionId,
      runId: String(this.attempts.forDecision(record.decisionId)?.run_id ?? capture.runId),
      handId: capture.state.handId!,
      createdAt: new Date(record.startedAt).toISOString(),
      context,
      candidates: buildCandidates(capture.state),
      status:
        record.decisionSource === 'stopped'
          ? record.stopReason === 'CANCELLED'
            ? 'cancelled'
            : 'failed'
          : 'proposed',
      fallbackReason: record.stopReason ?? null,
      timing: {
        ...capture.timing,
        providerMs: record.modelLatencyMs ?? record.finishedAt - record.startedAt,
      },
      proposal: {
        candidateId: record.action?.id ?? '',
        selected: record.action?.id ?? '',
        source: record.action ? 'jev' : 'unavailable',
        explanation:
          'Jev Score evaluated the legal candidates; the versioned strategy selection rule selected this action.',
        latencyMs: record.finishedAt - record.startedAt,
        model: record.model,
        probabilities: record.probabilities,
        attempts: attempts.map((attempt) => providerAttempt(attempt, this.options.model.id)),
        request,
        requestHash: digest(request),
        framework: {
          schema: 'duelloop-score-v1',
          decision: record,
          factsSnapshotDigest: capture.binding.factsSnapshotDigest,
          selection: strategy.decision.selection.mode,
        },
      },
    };
  }

  private failure(capture: Capture, error: unknown, runId = capture.runId): DecisionRecord {
    return {
      id: randomUUID(),
      runId,
      handId: capture.state.handId!,
      createdAt: new Date().toISOString(),
      context: capture.context,
      candidates: buildCandidates(capture.state),
      status: 'failed',
      fallbackReason: error instanceof Error ? error.message : 'decision_failed',
      timing: capture.timing,
      proposal: {
        source: 'unavailable',
        selected: '',
        candidateId: '',
        latencyMs: 0,
        explanation: 'Decision preparation failed; no action submitted.',
      },
    };
  }

  recoverProjections(): void {
    const key = `sdk-decisions:${this.options.scopeId}`;
    while (true) {
      const events = this.sdk.events({
        scopeId: this.options.scopeId,
        types: ['decision'],
        afterId: this.journal.cursor(key),
        limit: 100,
      });
      for (const event of events) {
        const record = event.data as unknown as SdkDecision;
        const obs = record.observation;
        const row = this.journal.db
          .prepare(
            'SELECT payload FROM framework_contexts WHERE scope=? AND stream=? AND revision=?',
          )
          .get(obs.strategyScopeId, obs.streamId, obs.revision);
        if (!row) throw new Error('SDK decision has no original host context');
        const capture = JSON.parse(String(row.payload)) as Capture;
        this.journal.atomic(() => {
          this.attempts.attach(record, event.id);
          const decision = this.project(record, capture);
          this.journal.decision(record, decision.runId);
          this.options.raw.saveDecision(decision);
          this.journal.advance(key, event.id);
        });
      }
      if (events.length < 100) break;
    }
  }

  beforeSend(action: StoredAction, state: PokerState): void {
    this.bridge.beforeSend(action, state);
  }
  private recoverPreparedActions(): void {
    for (const intent of this.sdk.unresolvedIntents(this.options.scopeId)) {
      if (
        this.journal.db
          .prepare('SELECT 1 FROM framework_execution WHERE decision_id=?')
          .get(intent.decisionId)
      )
        continue;
      const record = this.journal.getDecision(intent.decisionId);
      const obs = record?.observation;
      if (!record || !obs) throw new Error('Execution intent is missing its decision evidence');
      const row = this.journal.db
        .prepare('SELECT payload FROM framework_contexts WHERE scope=? AND stream=? AND revision=?')
        .get(obs.strategyScopeId, obs.streamId, obs.revision);
      if (!row) throw new Error('Execution intent is missing its original authority context');
      const capture = JSON.parse(String(row.payload)) as Capture;
      const candidate = buildCandidates(capture.state).find(
        (item) => item.id === record.action?.id,
      );
      if (!candidate || !capture.state.turnToken || !capture.state.handId || !capture.state.tableId)
        throw new Error('Execution intent cannot recover its original payload');
      this.bridge.prepare({
        id: intent.command.idempotencyKey,
        decisionId: record.decisionId,
        runId: String(this.attempts.forDecision(record.decisionId)?.run_id ?? capture.runId),
        tableId: capture.state.tableId,
        status: 'prepared',
        createdAt: new Date(record.finishedAt).toISOString(),
        deadlineAt: intent.command.deadline,
        stateKey: decisionStateKey(capture.state, false),
        decisionSource: 'jev',
        timing: capture.timing,
        payload: {
          type: 'action',
          action: candidate.action,
          ...(candidate.action === 'raise' ? { amount: candidate.amount } : {}),
          hand_id: capture.state.handId,
          turn_token: capture.state.turnToken,
          client_action_id: intent.command.idempotencyKey,
        },
      });
    }
  }
  async resume(action: StoredAction, state: PokerState): Promise<void> {
    this.options.raw.assertRuntimeLease();
    this.bridge.flushReceipts();
    const record = this.journal.getDecision(action.decisionId);
    if (!record) throw new Error('Legacy unresolved command cannot be resumed by DuelLoop');
    const obs = record.observation;
    const row = this.journal.db
      .prepare('SELECT payload FROM framework_contexts WHERE scope=? AND stream=? AND revision=?')
      .get(obs.strategyScopeId, obs.streamId, obs.revision);
    if (!row) throw new Error('Original execution context missing');
    const capture = JSON.parse(String(row.payload)) as Capture;
    const task: DecisionTask = {
      key: actionAuthorityKey(action),
      stateKey: decisionStateKey(state),
      state,
      receivedAt: obs.observedAt,
      deadlineAt: action.deadlineAt,
      decisionDeadlineAt: record.modelDeadline,
      controller: new AbortController(),
      opponents: [],
      recovered: true,
      recoveryDeadlineKnown: true,
    };
    this.current = { task, capture };
    try {
      await this.runtime.resumeHostExecution(record);
    } finally {
      if (this.current?.task === task) this.current = undefined;
    }
  }
  async close(): Promise<void> {
    try {
      await this.bridge.flush();
    } finally {
      try {
        await this.runtime.close();
      } finally {
        this.sdk.close();
      }
    }
  }
}
