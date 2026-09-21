import { randomUUID } from 'node:crypto';
import type { PokerState, Policy, ProviderMeter } from '../core/types.js';
import { JevProvider } from '../policies/jev.js';
import { BaselinePolicy } from '../policies/baseline.js';
import { PokerRuntime } from '../runtime/runtime.js';
import type { Overview, RuntimeView, StrategyName, TableView } from '../shared/api.js';
import { Store } from '../storage/store.js';
import { Queries } from '../storage/queries.js';
import { LedgerMeter } from '../storage/provider-meter.js';
import { HybridPolicy } from '../policies/hybrid.js';
import { ReasoningProvider } from '../policies/reasoning.js';
import { DeepSeekProvider } from '../policies/deepseek.js';
import { seedDemo } from '../storage/demo.js';
import { json } from '../storage/database.js';
import type { AppConfig } from './config.js';
import type { ServerEvent } from '../openpoker/protocol.js';
import { SpectatorFeed } from './spectator.js';

export interface RunRequest {
  strategy: StrategyName;
  buyIn: number;
  maxHands: number;
  maxMinutes: number;
  autoRebuy: boolean;
}
export function reasoningFor(config: AppConfig, meter?: ProviderMeter): ReasoningProvider {
  if (config.reasoningProvider === 'deepseek')
    return new DeepSeekProvider({
      apiKey: config.reasoningApiKey,
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
      thinking: config.deepseekThinking,
      timeoutMs: config.reasoningTimeoutMs,
      effort: config.reasoningEffort,
      maxOutputTokens: config.reasoningMaxOutputTokens,
      meter,
    });
  return new ReasoningProvider({
    apiKey: config.reasoningApiKey,
    baseUrl: config.reasoningBaseUrl,
    protocol: config.reasoningProtocol,
    model:
      config.reasoningProtocol === 'messages'
        ? config.reasoningMessagesModel
        : config.reasoningModel,
    timeoutMs: config.reasoningTimeoutMs,
    effort: config.reasoningEffort,
    maxOutputTokens: config.reasoningMaxOutputTokens,
    meter,
  });
}
export function ledgerFor(config: AppConfig, store: Store, runId: string): LedgerMeter {
  return new LedgerMeter(store, runId, {
    reasoningInputPerMillion: config.reasoningInputPricePerMillion,
    reasoningCacheReadInputPerMillion: config.reasoningCacheReadInputPricePerMillion,
    reasoningOutputPerMillion: config.reasoningOutputPricePerMillion,
  });
}
export function policyFor(
  config: AppConfig,
  strategy: StrategyName,
  meter?: ProviderMeter,
): Policy {
  if (strategy === 'baseline') return new BaselinePolicy();
  const jev = new JevProvider({
    apiKey: config.jevApiKey,
    baseUrl: config.jevBaseUrl,
    model: config.jevModel,
    timeoutMs: config.jevTimeoutMs,
    meter,
  });
  if (strategy === 'jev-reasoning') {
    if (!meter) throw new Error('Hybrid decisions require a provider usage ledger');
    return new HybridPolicy({
      jev,
      reasoning: reasoningFor(config, meter),
      totalBudgetMs: config.hybridTimeoutMs,
      reasoningMode: config.reasoningMode,
    });
  }
  return jev;
}

export class Controller {
  readonly queries: Queries;
  readonly spectator: SpectatorFeed;
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
    if (request.strategy !== 'baseline' && !this.config.jevApiKey)
      throw new Error('JEV_API_KEY is required');
    if (request.strategy === 'jev-reasoning' && !this.config.reasoningApiKey)
      throw new Error(
        `${this.config.reasoningProvider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'REASONING_API_KEY'} is required`,
      );
    if (this.starting || this.view().running) throw new Error('Runtime is already running');
    this.starting = true;
    try {
      await this.runtime?.settleDecisions();
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
      this.runtime = new PokerRuntime({
        apiKey: this.config.openPokerApiKey,
        policy: policyFor(
          this.config,
          request.strategy,
          request.strategy !== 'baseline' ? ledgerFor(this.config, this.store, runId) : undefined,
        ),
        store: this.store,
        wsUrl: this.config.openPokerWsUrl,
        restUrl: this.config.openPokerRestUrl,
      });
      this.observeRuntime(this.runtime);
      const runtime = this.runtime;
      runtime.once('stopped', () => {
        void runtime.settleDecisions().then(() => {
          if (this.runtime === runtime) this.releaseLease();
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
        ...(request.strategy === 'jev-reasoning'
          ? {
              reasoning: {
                provider: this.config.reasoningProvider,
                protocol: this.config.reasoningProtocol,
                model:
                  this.config.reasoningProvider === 'deepseek'
                    ? this.config.deepseekModel
                    : this.config.reasoningProtocol === 'messages'
                      ? this.config.reasoningMessagesModel
                      : this.config.reasoningModel,
                ...(this.config.reasoningProvider === 'deepseek'
                  ? { thinking: this.config.deepseekThinking }
                  : {}),
                ...(this.config.reasoningProvider !== 'deepseek' ||
                this.config.deepseekThinking === 'enabled'
                  ? {
                      effort:
                        this.config.reasoningProvider === 'deepseek' &&
                        this.config.reasoningEffort === 'medium'
                          ? 'high'
                          : this.config.reasoningEffort,
                    }
                  : {}),
                timeoutMs: this.config.reasoningTimeoutMs,
              },
            }
          : {}),
        buyIn: request.buyIn,
        maxHands: request.maxHands,
        maxDurationMs: request.maxMinutes * 60_000,
        autoRebuy: request.autoRebuy,
        decisionTimeoutMs:
          request.strategy === 'jev-reasoning'
            ? this.config.hybridTimeoutMs
            : this.config.jevDecisionTimeoutMs,
      });
      return this.view();
    } catch (error) {
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
    this.releaseLease();
    this.detachSpectator?.();
    this.spectator.close();
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
