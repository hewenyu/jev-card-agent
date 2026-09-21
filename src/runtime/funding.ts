import { randomUUID } from 'node:crypto';
import type { OpenPokerClient, RebuyResult } from '../openpoker/client.js';
import { record, type ServerEvent } from '../openpoker/protocol.js';
import type { FundingEventView, FundingView } from '../shared/api.js';
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
  private observedAt = 0;
  private pending = new Map<string, { event: FundingEventView; identity: string }>();
  constructor(
    private readonly client: Pick<OpenPokerClient, 'seasonBalance'>,
    private readonly publish: (value: FundingView) => void,
    private readonly save?: (event: FundingEventView, dedupeKey: string) => void,
  ) {}
  start(autoRebuy: boolean, runId = '', restored?: Partial<FundingView>): void {
    this.stop();
    this.running = true;
    this.runId = runId;
    this.pending.clear();
    this.value = { ...initial(autoRebuy), ...restored, status: restored ? 'stale' : 'loading' };
    this.emit();
    void this.refresh();
    this.timer = setInterval(() => {
      if (!this.operation) void this.refresh();
    }, 15_000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.epoch++;
    this.operation?.abort();
    this.operation = null;
    if (!this.running) return;
    this.running = false;
    this.value.status = 'stale';
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
    }
    if (cooldown || event.type === 'rebuy_confirmed')
      this.remember(
        cooldown ? 'rebuy_scheduled' : 'rebuy_confirmed',
        'ws',
        fundingIdentity(event, sourceId),
      );
    void this.refresh();
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
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.running) return;
    const epoch = ++this.epoch;
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)]);
    const current = () => this.running && epoch === this.epoch;
    this.value.status = this.value.updatedAt ? 'stale' : 'loading';
    this.emit();
    try {
      const balance = await awaitWithAbort(signal, () => this.client.seasonBalance(signal));
      if (!current()) return;
      const before = this.value.availableChips;
      const previousTable = this.value.chipsAtTable;
      const first = this.value.updatedAt === null;
      if (balance) {
        this.value.availableChips = balance.chipBalance;
        this.value.chipsAtTable = balance.chipsAtTable;
        this.value.autoRebuy = balance.autoRebuy;
        this.value.rebuyCooldownSeconds = balance.pro ? 120 : 300;
      } else {
        this.value.availableChips = null;
        this.value.chipsAtTable = null;
      }
      this.value.updatedAt = new Date().toISOString();
      this.value.status = 'current';
      for (const { event, identity } of this.pending.values()) {
        this.save?.(
          {
            ...event,
            availableAfter: this.value.availableChips,
            chipsAtTable: this.value.chipsAtTable,
          },
          identity,
        );
      }
      this.pending.clear();
      if (
        first ||
        before !== this.value.availableChips ||
        previousTable !== this.value.chipsAtTable
      ) {
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
            rebuyAvailableAt: this.value.rebuyAvailableAt,
          },
          id,
        );
      }
      this.emit();
    } catch {
      if (!current()) return;
      this.value.status = 'stale';
      this.emit();
    } finally {
      if (this.operation === operation) this.operation = null;
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
