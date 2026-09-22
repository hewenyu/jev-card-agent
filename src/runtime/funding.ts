import { randomUUID } from 'node:crypto';
import type { OpenPokerClient, RebuyResult, SeasonBalance } from '../openpoker/client.js';
import { record, type ServerEvent } from '../openpoker/protocol.js';
import type { FundingEventView, FundingView, FundingSyncReason } from '../shared/api.js';
import { awaitWithAbort } from '../policies/abort.js';
import { fundingAvailableAt, fundingEventId, fundingIdentity } from '../storage/funding.js';

const refreshedEvents = new Set([
  'connected',
  'rebuy_confirmed',
  'auto_rebuy_scheduled',
  'auto_rebuy_set',
  'table_joined',
  'table_closed',
  'hand_result',
  'busted',
  'chips_skimmed',
  'season_ended',
]);
const initial = (autoRebuy: boolean): FundingView => ({
  seasonScore: null,
  seasonId: null,
  availableChips: null,
  chipsAtTable: null,
  autoRebuy,
  rebuyAmount: 1500,
  rebuyCooldownSeconds: 300,
  rebuyAvailableAt: null,
  lastRebuyAt: null,
  updatedAt: null,
  observedAt: new Date().toISOString(),
  status: 'loading',
});

/** One read-only account reconciliation loop, independent of table actions and page requests. */
export class FundingMonitor {
  private value = initial(false);
  private running = false;
  private epoch = 0;
  private operation: AbortController | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private runId = '';
  private hasRunSnapshot = false;
  private boundaries = new Set<FundingSyncReason>();
  private observedAt = 0;
  private pending = new Map<string, { event: FundingEventView; identity: string }>();
  constructor(
    private readonly client: Pick<OpenPokerClient, 'seasonBalance'>,
    private readonly publish: (value: FundingView) => void,
    private readonly save?: (event: FundingEventView, dedupeKey: string) => void,
  ) {}
  start(autoRebuy: boolean, runId = '', restored?: Partial<FundingView>): Promise<boolean> {
    this.stop();
    this.running = true;
    this.runId = runId;
    this.pending.clear();
    this.boundaries.clear();
    this.hasRunSnapshot = false;
    this.value = { ...initial(autoRebuy), ...restored, status: restored ? 'stale' : 'loading' };
    this.emit();
    const startup = this.refresh('startup');
    this.timer = setInterval(() => {
      if (!this.operation) void this.refresh();
    }, 15_000);
    this.timer.unref();
    return startup;
  }
  stop(preserveCurrent = false): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.epoch++;
    this.operation?.abort();
    this.operation = null;
    if (!this.running) return;
    this.running = false;
    if (!preserveCurrent) this.value.status = 'stale';
    this.emit();
  }
  observe(event: ServerEvent, heroSeat: number | null, sourceId: string = randomUUID()): void {
    if (!this.running) return;
    const detail = record(event.details);
    const cooldown =
      event.type === 'auto_rebuy_scheduled' ||
      (event.type === 'error' && (event.code ?? detail.code) === 'rebuy_cooldown');
    const departed = event.type === 'player_left' && event.seat === heroSeat;
    if (!refreshedEvents.has(event.type) && !cooldown && !departed) return;
    if (cooldown) {
      this.value.rebuyAvailableAt = fundingAvailableAt(event, new Date().toISOString());
    } else if (event.type === 'rebuy_confirmed') {
      this.value.lastRebuyAt = new Date().toISOString();
      this.value.rebuyAvailableAt = null;
    } else if (event.type === 'auto_rebuy_set' && typeof event.enabled === 'boolean') {
      this.value.autoRebuy = event.enabled;
    } else if (event.type === 'season_ended') {
      this.value = initial(this.value.autoRebuy);
      this.hasRunSnapshot = false;
      this.pending.clear();
    }
    if (cooldown || event.type === 'rebuy_confirmed')
      this.remember(
        cooldown ? 'rebuy_scheduled' : 'rebuy_confirmed',
        'ws',
        fundingIdentity(event, sourceId),
      );
    void this.refresh(event.type === 'table_joined' ? 'table_joined' : 'event');
  }
  restRebuy(result: RebuyResult): void {
    if (!this.running) return;
    if (result.status === 'confirmed') {
      this.value.lastRebuyAt = new Date().toISOString();
      this.value.rebuyAvailableAt = null;
      this.remember('rebuy_confirmed', 'rest', `rest:${randomUUID()}`);
    } else if (result.status === 'cooldown') {
      this.value.rebuyAvailableAt =
        result.retryAfterMs === undefined
          ? null
          : new Date(Date.now() + result.retryAfterMs).toISOString();
      this.remember('rebuy_scheduled', 'rest', `rest:${randomUUID()}`);
    }
    void this.refresh('event');
  }
  /** A caller that already fetched the official account can publish that exact observation. */
  reconcile(balance: SeasonBalance | null, reason: FundingSyncReason): boolean {
    if (!this.running) return false;
    this.epoch++;
    this.operation?.abort();
    this.operation = null;
    return this.applySnapshot(balance, reason);
  }
  async refresh(reason: FundingSyncReason = 'poll'): Promise<boolean> {
    if (!this.running) return false;
    if (reason !== 'poll' && reason !== 'event') this.boundaries.add(reason);
    const epoch = ++this.epoch;
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    const timer = setTimeout(
      () => operation.abort(new Error('Account reconciliation timed out')),
      10_000,
    );
    const current = () => this.running && epoch === this.epoch;
    this.value.status = this.value.updatedAt ? 'stale' : 'loading';
    this.emit();
    try {
      const balance = await awaitWithAbort(operation.signal, () =>
        this.client.seasonBalance(operation.signal),
      );
      if (!current()) return false;
      return this.applySnapshot(balance, reason);
    } catch {
      if (!current()) return false;
      this.value.status = 'stale';
      this.emit();
      return false;
    } finally {
      clearTimeout(timer);
      if (this.operation === operation) this.operation = null;
    }
  }
  private applySnapshot(balance: SeasonBalance | null, reason: FundingSyncReason): boolean {
    const previous = structuredClone(this.value);
    if (reason !== 'poll' && reason !== 'event') this.boundaries.add(reason);
    try {
      if (
        balance &&
        (!Number.isSafeInteger(balance.chipBalance) ||
          balance.chipBalance < 0 ||
          !Number.isSafeInteger(balance.chipsAtTable) ||
          balance.chipsAtTable < 0 ||
          (balance.score != null && !Number.isFinite(balance.score)))
      )
        throw new Error('Invalid official season balance');
      const before = this.value.availableChips;
      const previousTable = this.value.chipsAtTable;
      const previousScore = this.value.seasonScore;
      const previousSeason = this.value.seasonId;
      this.value.availableChips = balance?.chipBalance ?? null;
      this.value.chipsAtTable = balance?.chipsAtTable ?? null;
      // Unknown official score is never inferred from balances or carried over from another observation.
      this.value.seasonScore = balance?.score ?? null;
      this.value.seasonId = balance?.seasonId ?? null;
      if (balance) {
        this.value.autoRebuy = balance.autoRebuy;
        this.value.rebuyCooldownSeconds = balance.pro ? 120 : 300;
      }
      this.value.updatedAt = new Date().toISOString();
      this.value.status = 'current';
      for (const { event, identity } of this.pending.values()) {
        this.save?.(
          {
            ...event,
            availableAfter: this.value.availableChips,
            chipsAtTable: this.value.chipsAtTable,
            seasonScore: this.value.seasonScore,
            seasonId: this.value.seasonId,
          },
          identity,
        );
      }
      this.pending.clear();
      const changed =
        !this.hasRunSnapshot ||
        before !== this.value.availableChips ||
        previousTable !== this.value.chipsAtTable ||
        previousScore !== this.value.seasonScore ||
        previousSeason !== this.value.seasonId;
      const reasons = [...this.boundaries];
      if (!reasons.length && changed) reasons.push(reason);
      for (const syncReason of reasons) {
        const id = randomUUID();
        this.save?.(
          {
            id,
            runId: this.runId,
            createdAt: this.value.updatedAt,
            kind: 'balance_sync',
            source: 'reconciliation',
            amount: null,
            availableBefore: before,
            availableAfter: this.value.availableChips,
            chipsAtTable: this.value.chipsAtTable,
            seasonScore: this.value.seasonScore,
            seasonId: this.value.seasonId,
            rebuyAvailableAt: this.value.rebuyAvailableAt,
            syncReason,
          },
          id,
        );
      }
      this.boundaries.clear();
      this.hasRunSnapshot = true;
      this.emit();
      return true;
    } catch {
      this.value = { ...previous, status: 'stale' };
      this.emit();
      return false;
    }
  }
  private remember(kind: FundingEventView['kind'], source: 'ws' | 'rest', identity: string): void {
    const event: FundingEventView = {
      id: fundingEventId(identity),
      runId: this.runId,
      createdAt: new Date().toISOString(),
      kind,
      source,
      amount: kind === 'rebuy_confirmed' ? 1500 : null,
      // A periodic snapshot cannot establish the balance immediately before this rebuy.
      availableBefore: null,
      availableAfter: null,
      chipsAtTable: null,
      rebuyAvailableAt: this.value.rebuyAvailableAt,
    };
    this.pending.set(event.id, { event, identity });
    try {
      this.save?.(event, identity);
    } catch {
      this.value.status = 'stale';
    }
  }
  private emit(): void {
    this.observedAt = Math.max(Date.now(), this.observedAt + 1);
    this.value.observedAt = new Date(this.observedAt).toISOString();
    this.publish(structuredClone(this.value));
  }
}
