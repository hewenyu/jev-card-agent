import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  createInitialState,
  reduceMessage,
  validateCandidate,
  OpponentTracker,
} from '../core/index.js';
import type { PokerState } from '../core/types.js';
import { OpenPokerClient } from '../openpoker/client.js';
import {
  parseEvent,
  record,
  string,
  verifyStateHash,
  type ServerEvent,
} from '../openpoker/protocol.js';
import { LobbyLifecycle } from './lobby.js';
import { FundingMonitor } from './funding.js';
import type { DecisionTask } from './engine.js';
import {
  actionAuthorityKey,
  decisionStateKey,
  runtimeDefaults as defaults,
  atHandBoundary,
  authorityKey,
  validateStartOptions,
} from './authority.js';
import { markAcknowledged, markSent } from './timing.js';
import { recordDecision } from './recording.js';
import { runtimeStatus } from './status.js';
import { pinHand } from './pinning.js';
import type {
  DecisionRecord,
  RuntimeDependencies,
  RuntimeStatus,
  StartOptions,
  StoredAction,
} from './types.js';

export class PokerRuntime extends EventEmitter {
  private readonly client: OpenPokerClient;
  private readonly lobby: LobbyLifecycle;
  private readonly funding: FundingMonitor;
  private socket: WebSocket | null = null;
  private options = { ...defaults };
  private snapshot: RuntimeStatus = {
    runId: null,
    phase: 'idle',
    connected: false,
    hands: 0,
    decisions: 0,
    reconnects: 0,
    startedAt: null,
    stoppedAt: null,
    lastError: null,
    state: createInitialState(),
  };
  private running = false;
  private finishing = false;
  private leaving = false;
  private leaveAttempts = 0;
  private leaveVerification = false;
  private stopRequested = false;
  private decisionHalted = false;
  private requireJev = true;
  private activeTask: DecisionTask | null = null;
  private decisionTasks = new Set<Promise<void>>();
  private knownTurns = new Set<string>();
  private turnDeadlines = new Map<
    string,
    { tableId: string; deadlineAt: number; decisionDeadlineAt: number }
  >();
  private completedHands = new Set<string>();
  private observedHands = new Set<string>();
  private pending = new Map<string, StoredAction>();
  private resuming = new Set<string>();
  private retryCount = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongAlive = true;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private lifetime = new AbortController();
  private resyncPending = false;
  private opponents = new OpponentTracker();
  private attempts = new Map<string, number>();
  private blockedAuthorities = new Set<string>();

  constructor(private readonly dependencies: RuntimeDependencies) {
    super();
    this.client = new OpenPokerClient(dependencies);
    this.funding = new FundingMonitor(
      this.client,
      (value) => {
        this.snapshot.funding = value;
        if (this.running) this.publish();
      },
      (event, dedupeKey) => this.dependencies.store.saveFundingEvent?.(event, dedupeKey),
    );
    this.lobby = new LobbyLifecycle(this.client, {
      ready: () => this.running && this.snapshot.connected && !this.stopRequested && !this.leaving,
      buyIn: () => this.options.buyIn,
      autoRebuy: () => this.options.autoRebuy,
      assertLease: () => this.dependencies.store.assertRuntimeLease?.(),
      send: (value) => {
        this.send(value);
      },
      join: (buyIn) => {
        this.snapshot.state = createInitialState();
        this.snapshot.phase = 'queued';
        this.send({ type: 'join_lobby', buy_in: buyIn });
        this.send({ type: 'set_auto_rebuy', enabled: this.options.autoRebuy });
        this.publish();
      },
      recover: (active) => {
        this.snapshot.state.tableId = active.table_id ?? null;
        this.snapshot.state.heroSeat = active.seat ?? this.snapshot.state.heroSeat;
        this.resync();
      },
      cooldown: () => {
        this.snapshot.phase = 'cooldown';
        this.publish();
      },
      fail: (error) => this.fail(error),
      fundingRebuy: (result) => this.funding.restRebuy(result),
      fundingSnapshot: (balance, reason) => this.funding.reconcile(balance, reason),
    });
  }
  async settleDecisions(): Promise<void> {
    await Promise.allSettled([...this.decisionTasks]);
  }
  status(): RuntimeStatus {
    return runtimeStatus(this.snapshot);
  }
  get state(): PokerState {
    return structuredClone(this.snapshot.state);
  }

  async start(options: StartOptions = {}): Promise<void> {
    if (this.running || this.finishing) throw new Error('Runtime is already running or finishing');
    this.options = { ...defaults, ...options };
    this.requireJev = options.kind !== 'demo' && options.strategy !== 'baseline';
    validateStartOptions(this.options);
    this.lifetime = new AbortController();
    this.lobby.resetSeason();
    this.stopRequested = false;
    this.decisionHalted = false;
    this.leaving = false;
    this.leaveAttempts = 0;
    this.leaveVerification = false;
    this.retryCount = 0;
    this.knownTurns.clear();
    this.turnDeadlines.clear();
    this.completedHands.clear();
    this.observedHands.clear();
    this.pending.clear();
    this.attempts.clear();
    this.blockedAuthorities.clear();
    this.opponents = new OpponentTracker();
    const checkpoint = this.dependencies.store.loadCheckpoint();
    this.opponents = new OpponentTracker(checkpoint?.opponents);
    this.snapshot = {
      runId: options.runId ?? randomUUID(),
      phase: 'connecting',
      connected: false,
      hands: 0,
      decisions: 0,
      reconnects: 0,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastError: null,
      state: checkpoint?.state ?? createInitialState(),
    };
    this.dependencies.store.beginRun({
      id: this.snapshot.runId!,
      kind: options.kind ?? 'live',
      strategy: options.strategy ?? 'jev',
      startedAt: this.snapshot.startedAt!,
      config: options,
    });
    for (const action of this.dependencies.store.pendingActions())
      this.pending.set(action.id, action);
    this.running = true;
    const startupFunding = this.funding.start(
      this.options.autoRebuy,
      this.snapshot.runId!,
      this.dependencies.store.loadFundingState?.(),
    );
    if (this.options.maxDurationMs > 0) {
      this.durationTimer = setTimeout(() => this.stop(true), this.options.maxDurationMs);
    }
    this.publish();
    try {
      await startupFunding;
      if (!this.running) return;
      const active = await this.client.activeGame(this.lifetime.signal);
      if (!this.running) return;
      if (active.playing) {
        if (this.snapshot.state.tableId !== active.table_id)
          this.snapshot.state = createInitialState();
        this.snapshot.state.tableId = active.table_id ?? null;
        this.snapshot.state.heroSeat = active.seat ?? this.snapshot.state.heroSeat;
      } else {
        this.snapshot.state = createInitialState();
        this.markAllUnresolved('not_seated_on_start');
      }
      this.connect();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Graceful mode waits for the current hand boundary; zero means no drain timeout. */
  stop(graceful = true): void {
    if (!this.running) return;
    this.stopRequested = true;
    this.lobby.cancel();
    this.snapshot.phase = 'stopping';
    this.publish();
    const idleBoundary = atHandBoundary(this.snapshot.state);
    if (!graceful || !this.snapshot.state.handId || this.snapshot.state.complete || idleBoundary) {
      this.leave();
      return;
    }
    if (this.options.gracefulStopTimeoutMs > 0) {
      this.stopTimer ??= setTimeout(() => this.leave(), this.options.gracefulStopTimeoutMs);
    }
  }

  private publish(): void {
    this.emit('status', this.status());
  }
  private connect(): void {
    if (!this.running) return;
    this.snapshot.phase = this.stopRequested ? 'stopping' : 'connecting';
    this.publish();
    const socket = this.client.connect();
    this.socket = socket;
    socket.on('open', () => {
      if (socket !== this.socket) return;
      this.snapshot.connected = true;
      this.pongAlive = true;
      this.heartbeat = setInterval(() => {
        if (!this.pongAlive) {
          socket.terminate();
          return;
        }
        this.pongAlive = false;
        socket.ping();
      }, 20_000);
      this.publish();
    });
    socket.on('pong', () => {
      this.pongAlive = true;
    });
    socket.on('message', (raw) => {
      if (socket !== this.socket || !this.running) return;
      try {
        this.receive(parseEvent(raw.toString()));
      } catch (error) {
        this.fail(error);
      }
    });
    socket.on('error', (error) => {
      this.snapshot.lastError = error.message;
      this.publish();
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403)
        this.fail(new Error('OpenPoker authentication failed'));
      else socket.terminate();
    });
    socket.on('close', (code) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.lobby.cancel();
      this.snapshot.connected = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.cancelTask();
      this.resyncPending = false;
      if (this.resyncTimer) clearTimeout(this.resyncTimer);
      if (!this.running) return;
      if (code === 4001) {
        this.fail(new Error('OpenPoker authentication failed'));
        return;
      }
      if (this.leaving) {
        void this.verifyLeave();
        return;
      }
      this.reconnect();
    });
  }

  private reconnect(): void {
    if (++this.retryCount > this.options.maxReconnectAttempts) {
      this.fail(new Error('Reconnect attempts exhausted'));
      return;
    }
    this.snapshot.reconnects++;
    this.snapshot.phase = 'recovering';
    this.publish();
    const cap = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** Math.min(this.retryCount - 1, 16),
    );
    this.reconnectTimer = setTimeout(
      () => this.connect(),
      Math.floor(cap * (0.5 + Math.random() * 0.5)),
    );
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }
  private join(): void {
    if (this.stopRequested) {
      this.leave();
      return;
    }
    this.lobby.requestJoin();
  }

  private resync(): void {
    if (this.resyncPending || !this.snapshot.state.tableId) return;
    this.resyncPending = this.send({
      type: 'resync_request',
      table_id: this.snapshot.state.tableId,
      last_table_seq: Math.max(0, this.snapshot.state.lastTableSeq),
    });
    if (this.resyncPending) {
      if (this.resyncTimer) clearTimeout(this.resyncTimer);
      this.resyncTimer = setTimeout(() => this.socket?.terminate(), 10_000);
    }
    this.snapshot.phase = this.stopRequested ? 'stopping' : 'recovering';
    this.publish();
  }

  private receive(event: ServerEvent): void {
    const receivedAt = Date.now();
    const runId = this.snapshot.runId!;
    const sourceId = this.dependencies.store.appendEvent(
      runId,
      event,
      new Date(receivedAt).toISOString(),
    );
    this.emit('event', event);
    this.funding.observe(
      event,
      this.snapshot.state.heroSeat,
      sourceId === undefined ? undefined : String(sourceId),
    );
    // Account events are independent of table sequence and can refer to a departed table.
    if (event.type === 'auto_rebuy_scheduled' || event.type === 'rebuy_confirmed') {
      if (event.type === 'auto_rebuy_scheduled') this.lobby.scheduled(event);
      else this.lobby.confirmed();
      this.publish();
      return;
    }
    if (event.type === 'connected') {
      if (this.leaving) this.leave();
      else if (this.snapshot.state.tableId) {
        this.send({ type: 'set_auto_rebuy', enabled: this.options.autoRebuy });
        this.resync();
      } else this.join();
      return;
    }
    if (event.type === 'error') {
      this.handleError(event);
      return;
    }
    if (event.type === 'action_ack' || event.type === 'action_rejected') {
      this.acknowledge(event);
      // Acknowledgements may arrive below the state watermark and still matter.
      if (event.type === 'action_rejected') {
        this.cancelTask();
        this.blockedAuthorities.add(authorityKey(this.snapshot.state));
        this.resync();
      }
      return;
    }
    if (event.type === 'player_action') this.acknowledge(event);
    if (event.type === 'resync_response') {
      this.applyResync(event, receivedAt);
      return;
    }
    const previous = this.snapshot.state;
    if (
      event.table_id &&
      previous.tableId &&
      event.table_id !== previous.tableId &&
      event.type !== 'table_joined'
    )
      return;
    if (
      event.table_seq != null &&
      event.table_seq <= previous.lastTableSeq &&
      event.type !== 'table_joined'
    )
      return;
    if (event.type === 'table_state' && !verifyStateHash(event)) {
      this.cancelTask();
      this.resync();
      return;
    }
    this.snapshot.state = reduceMessage(previous, event);
    if (this.activeTask && authorityKey(this.snapshot.state) !== this.activeTask.key)
      this.cancelTask();
    if (event.type === 'lobby_joined' || event.type === 'table_joined') this.retryCount = 0;
    if (event.type === 'table_joined') {
      this.lobby.seated();
      this.snapshot.phase = 'playing';
      this.resyncPending = false;
    }
    if (previous.handId !== this.snapshot.state.handId) {
      this.cancelTask();
      this.knownTurns.clear();
      this.turnDeadlines.clear();
      this.blockedAuthorities.clear();
    }
    if ((event.type === 'hand_start' || event.type === 'your_turn') && this.snapshot.state.handId) {
      this.observedHands.add(this.snapshot.state.handId);
    }
    this.persist(event);
    if (this.stopRequested && event.type === 'table_state' && atHandBoundary(this.snapshot.state)) {
      this.leave();
      return;
    }
    if (event.type === 'your_turn') this.authorize(false, event, receivedAt);
    else if (event.type === 'hand_result') this.completeHand(event);
    else if (event.type === 'table_closed' || event.type === 'season_ended') {
      this.cancelTask();
      this.markAllUnresolved(event.type);
      this.resyncPending = false;
      if (event.type === 'season_ended') this.lobby.resetSeason();
      else this.lobby.departed();
      if (this.stopRequested) this.leave();
      else this.join();
    } else if (event.type === 'busted') {
      this.cancelTask();
      if (!this.options.autoRebuy || this.stopRequested) this.leave();
      else this.lobby.busted();
    } else if (event.type === 'player_left' && event.seat === this.snapshot.state.heroSeat) {
      this.cancelTask();
      this.snapshot.state = createInitialState();
      this.lobby.departed();
      if (this.stopRequested) this.finish('stopped');
      else this.join();
    }
    this.publish();
  }

  private persist(event: ServerEvent): void {
    this.opponents.observe(this.snapshot.state);
    if (
      this.snapshot.state.handId &&
      !this.snapshot.state.complete &&
      ['hand_start', 'your_turn', 'resync_response'].includes(event.type)
    )
      pinHand(this.dependencies, this.snapshot, this.lifetime, this.fail.bind(this));
    this.dependencies.store.saveCheckpoint({
      opponents: this.opponents.exportState(),
      tableId: this.snapshot.state.tableId,
      lastTableSeq: this.snapshot.state.lastTableSeq,
      state: this.snapshot.state,
    });
    if (this.snapshot.state.handId)
      this.dependencies.store.saveHand(this.snapshot.runId!, this.snapshot.state, event);
  }

  private applyResync(event: ServerEvent, receivedAt = Date.now()): void {
    this.resyncPending = false;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    if (
      event.table_id &&
      this.snapshot.state.tableId &&
      event.table_id !== this.snapshot.state.tableId
    )
      return;
    const snapshot = record(event.snapshot);
    const snapshotEvent = { ...snapshot, type: 'table_state' } as ServerEvent;
    if (snapshot.state_hash && !verifyStateHash(snapshot as ServerEvent)) {
      this.fail(new Error('Resync snapshot hash mismatch'));
      return;
    }
    const replayed = Array.isArray(event.replayed_events) ? event.replayed_events : [];
    replayed
      .map((value) => record(value) as ServerEvent)
      .sort((a, b) => (a.table_seq ?? 0) - (b.table_seq ?? 0))
      .forEach((item) => {
        if (item.table_seq != null && item.table_seq <= this.snapshot.state.lastTableSeq) return;
        this.dependencies.store.appendEvent(this.snapshot.runId!, item, new Date().toISOString());
        if (item.type === 'player_action') this.acknowledge(item);
        this.snapshot.state = reduceMessage(this.snapshot.state, item);
        this.persist(item);
        if (item.type === 'hand_result') this.completeHand(item);
      });
    if (!this.running || this.leaving) return;
    // Core installs resync snapshot after replay and grants authority only through hero.turn_token.
    this.snapshot.state = reduceMessage(this.snapshot.state, {
      ...event,
      replayed_events: [],
      snapshot: snapshotEvent,
    });
    this.retryCount = 0;
    this.lobby.seated();
    this.snapshot.phase = this.stopRequested ? 'stopping' : 'playing';
    if (this.snapshot.state.handId && !this.snapshot.state.complete) {
      this.observedHands.add(this.snapshot.state.handId);
    }
    this.persist(event);
    if (this.stopRequested && atHandBoundary(this.snapshot.state)) {
      this.leave();
      return;
    }
    const key = authorityKey(this.snapshot.state);
    for (const action of this.pending.values()) {
      if (actionAuthorityKey(action) !== key) {
        this.dependencies.store.updateAction(action.id, 'unresolved', {
          reason: 'authority_changed_without_confirmation',
        });
        this.pending.delete(action.id);
      }
    }
    this.authorize(true, event, receivedAt);
    this.publish();
  }

  private authorize(recovered: boolean, event: ServerEvent, receivedAt: number): void {
    const state = this.snapshot.state;
    if (!state.turnToken || !state.handId || !state.tableId || this.leaving || this.decisionHalted)
      return;
    const key = authorityKey(state);
    if (this.activeTask?.key === key || this.blockedAuthorities.has(key)) return;
    this.dependencies.store.assertRuntimeLease?.();
    this.cancelTask();
    let pending = [...this.pending.values()].find((action) => actionAuthorityKey(action) === key);
    if (pending && this.requireJev && pending.decisionSource !== 'jev') {
      this.dependencies.store.updateAction(pending.id, 'unresolved', {
        reason: 'non_jev_pending_action',
      });
      this.pending.delete(pending.id);
      pending = undefined;
    }
    if (pending) {
      if (pending.stateKey && pending.stateKey !== decisionStateKey(state, false)) {
        const reason = 'pending_decision_state_changed';
        this.dependencies.store.updateAction(pending.id, 'unresolved', { reason });
        this.dependencies.store.saveDecisionBlock?.({
          runId: this.snapshot.runId!,
          decisionId: pending.decisionId,
          reason,
          createdAt: new Date().toISOString(),
        });
        this.pending.delete(pending.id);
        this.blockedAuthorities.add(key);
        this.decisionHalted = true;
        this.snapshot.lastError = reason;
        this.stop(true);
        return;
      }
      if (this.resuming.has(key)) return;
      if (Date.now() < pending.deadlineAt) {
        this.resuming.add(key);
        const action = pending;
        const restore = this.dependencies.engine
          .resume(action, structuredClone(state))
          .then(() => {
            if (
              this.running &&
              this.snapshot.connected &&
              !this.leaving &&
              this.pending.has(action.id) &&
              authorityKey(this.snapshot.state) === key
            )
              this.submit(action);
          })
          .catch((error) => this.fail(error))
          .finally(() => {
            this.resuming.delete(key);
            this.decisionTasks.delete(restore);
          });
        this.decisionTasks.add(restore);
      } else {
        this.dependencies.store.updateAction(pending.id, 'unresolved', {
          reason: 'deadline_elapsed',
        });
        this.pending.delete(pending.id);
      }
      return;
    }
    if (this.knownTurns.has(key)) return;
    this.knownTurns.add(key);
    const eventTime = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    const startedAt = Number.isFinite(eventTime) ? Math.min(receivedAt, eventTime) : receivedAt;
    const remembered = this.turnDeadlines.get(key) ?? this.dependencies.engine.loadTurn(key);
    const timing = remembered?.tableId === state.tableId ? remembered : undefined;
    const deadlineAt =
      timing?.deadlineAt ??
      startedAt +
        (recovered ? Math.min(3000, this.options.turnTimeoutMs) : this.options.turnTimeoutMs);
    const decisionDeadlineAt =
      timing?.decisionDeadlineAt ??
      Math.min(
        receivedAt + this.options.decisionTimeoutMs,
        deadlineAt - this.options.submissionReserveMs,
      );
    // Only a live your_turn establishes time. Resync timestamps must never reset that clock.
    if (!recovered && !timing)
      this.turnDeadlines.set(key, { tableId: state.tableId, deadlineAt, decisionDeadlineAt });
    if (!recovered && !timing)
      this.dependencies.engine.rememberTurn(
        key,
        state.tableId,
        receivedAt,
        deadlineAt,
        decisionDeadlineAt,
      );
    const task: DecisionTask = {
      key,
      stateKey: decisionStateKey(state),
      receivedAt,
      decisionDeadlineAt,
      controller: new AbortController(),
      state: structuredClone(state),
      deadlineAt,
      recovered,
      recoveryDeadlineKnown: recovered && !!timing,
      requireJev: this.requireJev,
      opponents: this.opponents.snapshot(),
    };
    this.activeTask = task;
    this.emit('deciding', {
      runId: this.snapshot.runId,
      handId: state.handId,
      startedAt: new Date().toISOString(),
    });
    const budget = Math.max(
      0,
      Math.min(
        this.options.decisionTimeoutMs,
        decisionDeadlineAt - Date.now(),
        deadlineAt - Date.now() - this.options.submissionReserveMs,
      ),
    );
    const pendingDecision = this.dependencies.engine
      .decide(task, this.snapshot.runId!, budget, (progress) => {
        if (this.activeTask !== task || task.controller.signal.aborted || !this.matchesTask(task))
          return;
        this.snapshot.decision = progress;
        this.publish();
      })
      .then((result) => {
        if (!result) return;
        if (
          result.decision.status === 'cancelled' ||
          this.activeTask !== task ||
          task.controller.signal.aborted ||
          !this.running ||
          !this.snapshot.connected ||
          authorityKey(this.snapshot.state) !== task.key
        ) {
          result.decision.status = 'cancelled';
          result.decision.fallbackReason = 'decision_cancelled';
          recordDecision(this.dependencies.store, result.decision);
          if (this.activeTask === task) this.activeTask = null;
          return;
        }
        if (result.decision.status === 'failed' || !result.action) {
          this.pauseForDecisionFailure(result.decision, task);
          return;
        }
        const selected = result.decision.candidates.find(
          (candidate) => candidate.id === result.decision.proposal.candidateId,
        );
        const legal = !!selected && validateCandidate(selected, this.snapshot.state);
        if (!legal || !this.matchesTask(task)) {
          if (this.requireJev) {
            result.decision.status = 'failed';
            result.decision.fallbackReason = legal
              ? 'decision_state_changed'
              : 'candidate_no_longer_legal';
            result.decision.proposal = {
              ...result.decision.proposal,
              source: 'unavailable',
              candidateId: '',
              selected: '',
              explanation:
                'The decision state or legal candidates changed before submission; no action was submitted.',
            };
            this.pauseForDecisionFailure(result.decision, task);
          } else this.resync();
          return;
        }
        recordDecision(this.dependencies.store, result.decision, result.action);
        this.pending.set(result.action.id, result.action);
        this.snapshot.decisions++;
        this.emit('decision', result.decision);
        this.submit(result.action);
        this.activeTask = null;
        this.publish();
      })
      .catch((error) => this.fail(error))
      .finally(() => this.decisionTasks.delete(pendingDecision));
    this.decisionTasks.add(pendingDecision);
  }

  private matchesTask(task: DecisionTask): boolean {
    return (
      authorityKey(this.snapshot.state) === task.key &&
      (!task.stateKey || decisionStateKey(this.snapshot.state) === task.stateKey)
    );
  }

  private pauseForDecisionFailure(decision: DecisionRecord, task: DecisionTask): void {
    recordDecision(this.dependencies.store, decision);
    const reason = decision.fallbackReason ?? 'model_decision_unavailable';
    this.dependencies.store.saveDecisionBlock?.({
      runId: this.snapshot.runId!,
      decisionId: decision.id,
      reason,
      createdAt: new Date().toISOString(),
    });
    this.decisionHalted = true;
    this.snapshot.lastError = reason;
    this.activeTask = null;
    this.snapshot.decision = {
      id: decision.id,
      sessionId: decision.context.session!.id,
      tableId: task.state.tableId!,
      handId: task.state.handId!,
      phase: 'failed',
      startedAt: decision.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.emit('decision', decision);
    this.stop(true);
  }

  private submit(action: StoredAction): void {
    if (Date.now() >= action.deadlineAt || this.leaving) return;
    this.dependencies.store.assertRuntimeLease?.();
    const attempts = this.attempts.get(action.id) ?? 0;
    if (attempts >= 3) {
      this.dependencies.store.updateAction(action.id, 'unresolved', {
        reason: 'submission_retry_limit',
      });
      this.blockedAuthorities.add(actionAuthorityKey(action));
      return;
    }
    const sendStarted = Date.now();
    this.dependencies.engine.beforeSend(action, this.snapshot.state);
    if (this.send(action.payload)) {
      markSent(action.timing, sendStarted);
      if (action.timing)
        this.dependencies.store.saveDecisionTiming?.(action.decisionId, action.timing);
      this.attempts.set(action.id, attempts + 1);
      action.status = 'sent';
      this.dependencies.store.updateAction(action.id, 'sent');
      if (this.snapshot.decision?.id === action.decisionId) {
        this.snapshot.decision = {
          ...this.snapshot.decision,
          phase: 'submitted',
          updatedAt: new Date().toISOString(),
        };
      }
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.ackTimer = setTimeout(() => {
        if (this.pending.has(action.id)) this.resync();
      }, 3000);
    }
  }

  private acknowledge(event: ServerEvent): void {
    const id = string(event.client_action_id) ?? string(event.action_id);
    // Uncorrelated rejections never mark an arbitrary neighboring action as rejected.
    if (!id || !this.pending.has(id)) return;
    const action = this.pending.get(id)!;
    if (
      (event.hand_id && event.hand_id !== action.payload.hand_id) ||
      (event.table_id && event.table_id !== action.tableId)
    )
      return;
    const status =
      event.type === 'action_rejected' ||
      (event.type === 'action_ack' && event.status !== 'accepted')
        ? 'rejected'
        : 'accepted';
    markAcknowledged(action.timing);
    if (action.timing)
      this.dependencies.store.saveDecisionTiming?.(action.decisionId, action.timing);
    this.dependencies.store.updateAction(id, status, { code: event.code ?? null });
    this.pending.delete(id);
    this.attempts.delete(id);
    if (this.ackTimer) clearTimeout(this.ackTimer);
  }

  private completeHand(event: ServerEvent): void {
    const id = event.hand_id ?? this.snapshot.state.handId;
    if (id && this.observedHands.has(id) && !this.completedHands.has(id)) {
      this.completedHands.add(id);
      this.observedHands.delete(id);
      this.snapshot.hands++;
      // Bound process memory; these IDs only suppress near-term replay duplication.
      if (this.completedHands.size > 10_000)
        this.completedHands.delete(this.completedHands.values().next().value!);
    }
    this.cancelTask();
    if (
      this.stopRequested ||
      (this.options.maxHands > 0 && this.snapshot.hands >= this.options.maxHands)
    ) {
      this.stopRequested = true;
      this.leave();
    }
  }

  private handleError(event: ServerEvent): void {
    const code = string(event.code) ?? 'unknown';
    if (this.leaving && code === 'not_at_table') {
      this.finish('stopped');
      return;
    }
    if (code === 'already_in_lobby') return;
    if (code === 'already_seated') {
      const tableId = string(event.table_id) ?? string(record(event.details).table_id);
      if (tableId) {
        this.snapshot.state.tableId = tableId;
        this.resync();
      } else
        void this.client
          .activeGame(this.lifetime.signal)
          .then((active) => {
            if (!this.running) return;
            if (active.table_id) {
              this.snapshot.state.tableId = active.table_id;
              this.resync();
            } else this.fail(new Error('Already seated but active-game has no table'));
          })
          .catch((error) => this.fail(error));
      return;
    }
    if (code === 'rate_limited') {
      this.snapshot.lastError = code;
      const limitedSocket = this.socket;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (
          !this.running ||
          this.leaving ||
          !this.snapshot.connected ||
          this.socket !== limitedSocket
        )
          return;
        this.resyncPending = false;
        if (this.snapshot.state.tableId) this.resync();
        else {
          this.lobby.departed();
          this.join();
        }
      }, 1500);
      return;
    }
    if (code === 'table_not_found' || code === 'not_at_table') {
      this.markAllUnresolved(code);
      this.resyncPending = false;
      this.snapshot.state = createInitialState();
      this.lobby.departed();
      this.join();
      return;
    }
    if (code === 'insufficient_funds' && !this.stopRequested) {
      this.lobby.insufficientFunds();
      return;
    }
    if (code === 'rebuy_cooldown') {
      this.lobby.scheduled(event);
      return;
    }
    this.fail(new Error(`OpenPoker protocol error: ${code}`));
  }

  private cancelTask(): void {
    if (!this.activeTask) return;
    this.activeTask.controller.abort();
    // An interrupted call has no submission; recovery must honor the configured decision policy.
    this.knownTurns.delete(this.activeTask.key);
    this.activeTask = null;
  }
  private markAllUnresolved(reason: string): void {
    for (const action of this.pending.values())
      this.dependencies.store.updateAction(action.id, 'unresolved', { reason });
    this.pending.clear();
  }
  private leave(): void {
    if (!this.running) return;
    this.leaving = true;
    this.lobby.cancel();
    this.stopRequested = true;
    this.cancelTask();
    this.snapshot.phase = 'stopping';
    this.publish();
    if (!this.snapshot.connected) {
      void this.verifyLeave();
      return;
    }
    this.leaveAttempts++;
    this.send({ type: 'leave_table' });
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      void this.verifyLeave();
    }, 1500);
  }
  private async verifyLeave(): Promise<void> {
    if (!this.running || !this.leaving || this.leaveVerification) return;
    this.leaveVerification = true;
    try {
      const active = await this.client.activeGame(this.lifetime.signal);
      if (!this.running) return;
      if (!active.playing) this.finish('stopped');
      else if (this.snapshot.connected && this.leaveAttempts < 3) this.leave();
      else this.fail(new Error('Leave is unconfirmed: the server still reports an active seat'));
    } catch (error) {
      if (this.running)
        this.fail(
          new Error(
            `Unable to confirm leaving: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    } finally {
      this.leaveVerification = false;
    }
  }

  private fail(error: unknown): void {
    if (!this.running) return;
    this.snapshot.lastError = error instanceof Error ? error.message : String(error);
    this.finish('failed');
  }
  private async finish(phase: 'stopped' | 'failed'): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.finishing = true;
    this.lobby.cancel();
    this.cancelTask();
    this.lifetime.abort();
    for (const timer of [
      this.reconnectTimer,
      this.durationTimer,
      this.stopTimer,
      this.ackTimer,
      this.resyncTimer,
    ])
      if (timer) clearTimeout(timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
    if (phase === 'stopped') {
      this.snapshot.phase = 'stopping';
      this.publish();
      const reconciled = await this.funding.refresh('after_leave');
      this.funding.stop(reconciled);
      if (!reconciled)
        this.snapshot.lastError = [
          this.snapshot.lastError,
          'Final official account reconciliation failed; balance and score remain stale.',
        ]
          .filter(Boolean)
          .join(' ');
    } else this.funding.stop();
    this.snapshot.phase = phase;
    this.snapshot.connected = false;
    this.snapshot.stoppedAt = new Date().toISOString();
    try {
      this.markAllUnresolved('runtime_stopped');
      this.dependencies.store.finishRun(
        this.snapshot.runId!,
        phase,
        this.snapshot.stoppedAt,
        this.snapshot.lastError,
      );
    } catch (error) {
      this.snapshot.phase = 'failed';
      this.snapshot.lastError = `Persistence failure: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.finishing = false;
    this.publish();
    this.emit('stopped', this.status());
  }
}
