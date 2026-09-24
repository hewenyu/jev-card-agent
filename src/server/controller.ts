import { randomUUID } from 'node:crypto';
import type { PokerState } from '../core/types.js';
import { PokerRuntime } from '../runtime/runtime.js';
import type {
  DashboardOverview,
  Overview,
  RuntimeView,
  StrategyName,
  TableView,
} from '../shared/api.js';
import { Store } from '../storage/store.js';
import { Queries } from '../storage/queries.js';
import { seedDemo } from '../storage/demo.js';
import { json } from '../storage/database.js';
import type { AppConfig } from './config.js';
import type { ServerEvent } from '../openpoker/protocol.js';
import { SpectatorFeed } from './spectator.js';
import { ResearchMonitor } from './research-view.js';
import { FactsService } from '../facts/service.js';
import { DuelLoopResearchService } from '../duelloop/research/service.js';
import { publicResearchView } from '../duelloop/research/public-view.js';
import { LiveDecisionCoordinator } from '../duelloop/live/coordinator.js';
import { createLiveModel } from '../duelloop/live/model.js';
import { LiveUsageLedger } from '../duelloop/live/usage.js';
import type { AsyncResearchStatus } from '../research/engine.js';
import type { FrameworkStatusView } from '../shared/framework.js';
import { createInitialState } from '../core/state.js';
import { FrameworkControls } from './framework-controls.js';

export interface RunRequest {
  strategy: StrategyName;
  buyIn: number;
  maxHands: number;
  maxMinutes: number;
  autoRebuy: boolean;
}
export class Controller {
  readonly queries: Queries;
  readonly spectator: SpectatorFeed;
  readonly research: FactsService;
  readonly frameworkResearch: DuelLoopResearchService;
  coordinator: LiveDecisionCoordinator | null = null;
  readonly frameworkControls: FrameworkControls;
  private coordinatorClosing: Promise<void> | null = null;
  private lastFramework: Omit<FrameworkStatusView, 'research'> | null = null;
  readonly researchMonitor: ResearchMonitor;
  private researchTimer?: ReturnType<typeof setInterval>;
  private pendingResearchRefresh?: ReturnType<typeof setImmediate>;
  runtime: PokerRuntime | null = null;
  private strategy: StrategyName = 'jev';
  private starting = false;
  private closing = false;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private controllerError: string | null = null;
  private demoSelected: boolean;
  private detachSpectator?: () => void;
  constructor(
    readonly config: AppConfig,
    readonly store: Store,
  ) {
    this.queries = new Queries(store);
    this.demoSelected = config.demo;
    if (config.demo) {
      if (store.db.prepare("SELECT id FROM runs WHERE mode!='demo' LIMIT 1").get())
        throw new Error('Demo database contains live data; choose a clean demo database');
      seedDemo(store);
    }
    this.spectator = new SpectatorFeed(this.view());
    this.frameworkControls = new FrameworkControls(config, store);
    this.research = new FactsService(store.filename, config.factsDatabasePath, {
      enabled: config.researchEnabled && store.filename !== ':memory:',
      legacyAuditPath: config.knowledgeDatabasePath,
    });
    store.knowledgeSource = this.research;
    this.frameworkResearch = new DuelLoopResearchService(
      config.duelloopDatabasePath,
      config.duelloopScopeId,
      {
        ...config.duelloopResearch,
        enabled: config.duelloopResearch.enabled && store.filename !== ':memory:' && !config.demo,
      },
    );
    this.researchMonitor = new ResearchMonitor(
      config.asyncLlm.databasePath,
      store.db,
      this.legacyResearchStatus(),
    );
    this.research.on('update', () => this.scheduleResearchRefresh());
    this.frameworkResearch.on('update', () => this.scheduleResearchRefresh());
    void Promise.all([this.research.start(), this.frameworkResearch.start()])
      .then(() => this.refreshResearch())
      .catch(() => this.researchMonitor.fail());
    this.researchTimer = setInterval(() => this.scheduleResearchRefresh(), 2000);
    this.researchTimer.unref();
  }
  private scheduleResearchRefresh(): void {
    if (this.closing || this.pendingResearchRefresh) return;
    this.pendingResearchRefresh = setImmediate(() => {
      this.pendingResearchRefresh = undefined;
      this.refreshResearch();
      if (!this.closing) this.spectator.update(this.view());
    });
  }
  private refreshResearch(): void {
    if (this.closing) return;
    try {
      this.researchMonitor.refresh(this.legacyResearchStatus());
    } catch {
      this.researchMonitor.fail();
    }
  }
  async pauseResearch(): Promise<void> {
    clearInterval(this.researchTimer);
    this.researchTimer = undefined;
    clearImmediate(this.pendingResearchRefresh);
    this.pendingResearchRefresh = undefined;
    await Promise.all([this.research.stop(), this.frameworkResearch.stop()]);
    // A stopped WS loop can still be flushing its decision/outbox. Backup callers need
    // all host writers settled before copying the raw and SDK databases together.
    if (!this.view().running) {
      await this.runtime?.settleDecisions();
      await this.closeCoordinator();
    }
  }
  async restartResearch(): Promise<void> {
    if (this.closing) throw new Error('Controller is closing');
    await Promise.all([this.research.start(), this.frameworkResearch.start()]);
    if (this.closing) {
      await this.pauseResearch();
      return;
    }
    this.refreshResearch();
    if (!this.researchTimer) {
      this.researchTimer = setInterval(() => this.scheduleResearchRefresh(), 2000);
      this.researchTimer.unref();
    }
  }
  async start(request: RunRequest): Promise<RuntimeView> {
    if (this.store.loadDecisionBlock())
      throw new Error(
        'Bot paused after a model decision failure; use the private resume command after resolving it',
      );
    if (this.closing) throw new Error('Controller is closing');
    if (this.config.readOnlyDemo || this.config.demo)
      throw new Error('Live runtime is disabled in demo mode');
    if (!this.config.openPokerApiKey) throw new Error('OPENPOKER_API_KEY is required');
    if (request.strategy !== 'jev')
      throw new Error(
        'Live strategy must be jev; baseline and synchronous reasoning are offline-only',
      );
    if (!this.config.jevApiKey) throw new Error('JEV_API_KEY is required');
    if (this.starting || this.view().running) throw new Error('Runtime is already running');
    this.starting = true;
    try {
      await this.runtime?.settleDecisions();
      await this.closeCoordinator();
      if (this.closing) throw new Error('Controller is closing');
      if (!this.store.acquireLease()) throw new Error('Another runtime owns this database lease');
      // Acquiring the exclusive lease is the evidence that these prior runs have no owner.
      this.store.db
        .prepare(
          `UPDATE runs SET status='interrupted',ended_at=?,reason=?
        WHERE mode='live' AND status='running'`,
        )
        .run(
          new Date().toISOString(),
          'Previous runtime ended without a final status; starting from the saved checkpoint',
        );
      this.controllerError = null;
      this.strategy = request.strategy;
      this.demoSelected = false;
      const runId = randomUUID();
      const usage = new LiveUsageLedger(this.store, runId, this.config.jevModel);
      const model = createLiveModel(
        {
          apiKey: this.config.jevApiKey,
          baseUrl: this.config.jevBaseUrl,
          model: this.config.jevModel,
          timeoutMs: this.config.jevTimeoutMs,
        },
        { onStart: usage.start, onAttempt: usage.finish, onLateResult: usage.late },
      );
      const coordinator = new LiveDecisionCoordinator({
        raw: this.store,
        databasePath:
          this.store.filename === ':memory:' ? ':memory:' : this.config.duelloopDatabasePath,
        scopeId: this.config.duelloopScopeId,
        actorId: this.config.duelloopActorId,
        model,
        state: () => this.runtime?.state ?? createInitialState(),
        facts: (at) => this.research.latest(at),
        decisionPolicy: this.config.duelloopResearch.decisionPolicy,
      });
      this.coordinator = coordinator;
      this.runtime = new PokerRuntime({
        apiKey: this.config.openPokerApiKey,
        engine: coordinator,
        store: coordinator.bridge.store,
        wsUrl: this.config.openPokerWsUrl,
        restUrl: this.config.openPokerRestUrl,
      });
      this.observeRuntime(this.runtime);
      const runtime = this.runtime;
      runtime.once('stopped', () => {
        void runtime
          .settleDecisions()
          .then(async () => {
            if (this.runtime === runtime) {
              await this.closeCoordinator();
              this.releaseLease();
            }
          })
          .catch(() => {
            this.controllerError = 'Framework settlement failed; inspect durable execution state';
          });
      });
      this.leaseTimer = setInterval(() => {
        try {
          if (!this.store.acquireLease()) throw new Error('Runtime database lease was lost');
        } catch (error) {
          this.controllerError = error instanceof Error ? error.message : String(error);
          this.runtime?.stop(false);
        }
      }, 5000);
      await this.runtime.start({
        runId,
        strategy: request.strategy,
        buyIn: request.buyIn,
        maxHands: request.maxHands,
        maxDurationMs: request.maxMinutes * 60_000,
        autoRebuy: request.autoRebuy,
        decisionTimeoutMs: this.config.jevDecisionTimeoutMs,
        submissionReserveMs: this.config.duelloopResearch.decisionPolicy.executionReserveMs,
      });
      return this.view();
    } catch (error) {
      await this.closeCoordinator();
      this.releaseLease();
      throw error;
    } finally {
      this.starting = false;
    }
  }
  stop(graceful = true): RuntimeView {
    this.runtime?.stop(graceful);
    return this.view();
  }
  canAutoStart(): boolean {
    return this.store.loadDecisionBlock() === null;
  }
  async resume(
    request: RunRequest = {
      strategy: this.config.botStrategy,
      buyIn: 2000,
      maxHands: 0,
      maxMinutes: 0,
      autoRebuy: true,
    },
  ): Promise<RuntimeView> {
    if (this.starting || this.view().running) throw new Error('Runtime is already running');
    const previous = this.store.loadDecisionBlock();
    this.store.clearDecisionBlock();
    try {
      const view = await this.start(request);
      if (!view.running && previous && !this.store.loadDecisionBlock())
        this.store.saveDecisionBlock(previous);
      return view;
    } catch (error) {
      if (previous && !this.store.loadDecisionBlock()) this.store.saveDecisionBlock(previous);
      throw error;
    }
  }
  view(): RuntimeView {
    const blocked = this.store.loadDecisionBlock();
    const status = this.runtime?.status();
    const running = !!status && !['idle', 'stopped', 'failed'].includes(status.phase);
    const demoState = this.demoSelected
      ? json<PokerState | null>(
          this.store.db.prepare("SELECT value FROM meta WHERE key='demo_table'").get()?.value,
          null,
        )
      : null;
    return {
      running,
      research: this.research?.status(),
      asyncResearch: this.researchMonitor?.status(),
      framework: this.frameworkView(),
      ...(status?.funding ? { funding: status.funding } : {}),
      decision: status?.decision ?? null,
      status: this.starting
        ? 'connecting'
        : (status?.phase ?? (this.demoSelected ? 'demo' : blocked ? 'stopped' : 'idle')),
      mode: this.demoSelected ? 'demo' : status || blocked ? 'live' : 'idle',
      runId: status?.runId ?? (this.demoSelected ? 'demo-jev' : (blocked?.runId ?? null)),
      strategy: this.strategy,
      table: demoState
        ? tableView(demoState)
        : status?.state.tableId
          ? tableView(status.state)
          : null,
      error:
        this.controllerError ??
        status?.lastError ??
        (blocked ? `Model decision failed; bot paused: ${blocked.reason}` : null),
    };
  }
  dashboardOverview(): DashboardOverview {
    return {
      runtime: this.view(),
      runs: this.queries.runs({ limit: 100 }),
      capabilities: {
        canControl: !this.config.readOnlyDemo,
        liveConfigured: !!this.config.openPokerApiKey,
        jevConfigured: !!this.config.jevApiKey,
        reasoningConfigured: !!this.config.reasoningApiKey,
      },
    };
  }
  overview(): Overview {
    const runtime = this.view();
    const runs = this.queries.runs();
    const mode = runtime.mode === 'demo' ? 'demo' : 'live';
    const modeRuns = new Set(runs.filter((run) => run.mode === mode).map((run) => run.id));
    const hands = this.queries.hands();
    let total = 0;
    return {
      runtime,
      runs,
      recentHands: hands.slice(0, 12),
      metrics: this.queries.metrics(mode),
      performance: hands
        .filter((hand) => modeRuns.has(hand.runId) && hand.profit !== null)
        .reverse()
        .map((hand) => ({ label: hand.id, netChips: (total += hand.profit ?? 0) })),
      capabilities: {
        canControl: !this.config.readOnlyDemo,
        liveConfigured: !!this.config.openPokerApiKey,
        jevConfigured: !!this.config.jevApiKey,
        reasoningConfigured: !!this.config.reasoningApiKey,
      },
    };
  }
  resetDemo(): void {
    if (this.view().running)
      throw new Error('Stop the runtime before resetting the synthetic demo');
    this.store.db.exec(`BEGIN IMMEDIATE;
      DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE mode='demo');
      DELETE FROM actions WHERE run_id IN (SELECT id FROM runs WHERE mode='demo');
      DELETE FROM decisions WHERE run_id IN (SELECT id FROM runs WHERE mode='demo');
      DELETE FROM hands WHERE run_id IN (SELECT id FROM runs WHERE mode='demo');
      DELETE FROM runs WHERE mode='demo'; COMMIT;`);
    seedDemo(this.store);
    this.demoSelected = true;
    this.spectator.update(this.view());
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.view().running && this.runtime) {
      const runtime = this.runtime;
      await new Promise<void>((resolve) => {
        runtime.once('stopped', resolve);
        runtime.stop(false);
      });
    }
    await this.runtime?.settleDecisions();
    await this.closeCoordinator();
    await this.pauseResearch();
    this.researchMonitor.close();
    await this.frameworkControls.close();
    this.releaseLease();
    this.detachSpectator?.();
    this.spectator.close();
  }
  private legacyResearchStatus(): AsyncResearchStatus {
    return {
      configuredMode: 'off',
      mode: 'off',
      running: false,
      liveConfirmed: false,
      lastTickAt: null,
      error: null,
      pending: 0,
      runningJobs: 0,
      completed: 0,
      failed: 0,
      superseded: 0,
      cancelled: 0,
      attempts: 0,
      unknownUsage: 0,
      costUsd: 0,
      oldestPendingAt: null,
      latestCompletedAt: null,
    };
  }
  frameworkView(): FrameworkStatusView | undefined {
    if (!this.frameworkResearch || this.config.demo) return undefined;
    if (this.closing)
      return this.lastFramework
        ? { ...this.lastFramework, research: publicResearchView(this.frameworkResearch.status()) }
        : undefined;
    const coordinator = this.coordinator;
    let base = this.lastFramework;
    const current = this.frameworkControls.status();
    if (!coordinator) {
      base = {
        ...(base ?? {
          engine: 'duelloop',
          handReleaseDigest: null,
          factsSnapshotDigest: null,
          unresolvedIntents: 0,
        }),
        activeReleaseDigest: current.activeReleaseDigest,
        unresolvedIntents: this.frameworkControls.store.unresolvedIntents(
          this.config.duelloopScopeId,
        ).length,
      };
    }
    if (coordinator) {
      const hand = this.store.db
        .prepare(
          'SELECT release,facts_digest FROM framework_hands WHERE scope=? ORDER BY pinned_at DESC LIMIT 1',
        )
        .get(this.config.duelloopScopeId);
      base = {
        engine: 'duelloop',
        activeReleaseDigest: coordinator.sdk.activeRelease(this.config.duelloopScopeId),
        handReleaseDigest: hand?.release ? String(hand.release) : null,
        factsSnapshotDigest: hand?.facts_digest ? String(hand.facts_digest) : null,
        unresolvedIntents: coordinator.sdk.unresolvedIntents(this.config.duelloopScopeId).length,
      };
    }
    return {
      ...(base ?? {
        engine: 'duelloop',
        activeReleaseDigest: null,
        handReleaseDigest: null,
        factsSnapshotDigest: null,
        unresolvedIntents: 0,
      }),
      research: {
        ...publicResearchView(this.frameworkResearch.status()),
        activationMode: current.activationMode,
        activationPaused: current.activationPaused,
        pendingReleases: this.frameworkControls.store
          .pendingReleases(this.config.duelloopScopeId)
          .map((item) => ({
            digest: item.digest,
            validationDigest: item.binding.validationDigest,
          })),
      },
    };
  }
  private async closeCoordinator(): Promise<void> {
    if (this.coordinatorClosing) return this.coordinatorClosing;
    const coordinator = this.coordinator;
    if (!coordinator) return;
    const view = this.frameworkView();
    if (view) {
      const { research: _research, ...base } = view;
      this.lastFramework = base;
    }
    this.coordinator = null;
    this.coordinatorClosing = coordinator.close();
    try {
      await this.coordinatorClosing;
    } finally {
      this.coordinatorClosing = null;
    }
  }
  private observeRuntime(runtime: PokerRuntime): void {
    this.detachSpectator?.();
    let attached = true;
    let queued = false;
    let pending: ServerEvent[] = [];
    const schedule = () => {
      if (queued) return;
      queued = true;
      // The runtime emits event before applying its reducer; publish the resulting state.
      queueMicrotask(() => {
        queued = false;
        if (!attached || this.runtime !== runtime) return;
        const events = pending;
        pending = [];
        this.spectator.update(this.view(), events);
      });
    };
    const onEvent = (event: ServerEvent) => {
      if (typeof event.table_seq === 'number' && event.table_seq <= runtime.state.lastTableSeq)
        return;
      pending.push(event);
      pending = pending.slice(-128);
      schedule();
    };
    runtime.on('event', onEvent);
    runtime.on('status', schedule);
    this.detachSpectator = () => {
      attached = false;
      pending = [];
      runtime.off('event', onEvent);
      runtime.off('status', schedule);
    };
    this.spectator.update(this.view());
  }
  private releaseLease(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    this.store.releaseLease();
  }
}
function tableView(state: PokerState): TableView {
  return {
    tableId: state.tableId,
    handId: state.handId,
    street: state.street,
    pot: state.pot,
    board: state.board,
    heroCards: state.holeCards,
    heroSeat: state.heroSeat,
    dealerSeat: state.dealerSeat,
    actorSeat: state.actorSeat,
    stateSeq: state.lastTableSeq,
    complete: state.complete,
    seats: state.seats.map((seat) => ({
      seat: seat.seat,
      name: seat.name ?? 'Empty seat',
      stack: seat.stack,
      bet: seat.bet,
      folded: seat.folded ?? false,
      status: seat.status,
    })),
  };
}
