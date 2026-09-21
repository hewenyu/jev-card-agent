import type { ActiveGame, OpenPokerClient } from '../openpoker/client.js';
import { record, type ServerEvent } from '../openpoker/protocol.js';

interface LobbyHooks {
  ready(): boolean;
  buyIn(): number;
  autoRebuy(): boolean;
  assertLease(): void;
  send(value: Record<string, unknown>): void;
  join(buyIn: number): void;
  recover(active: ActiveGame): void;
  cooldown(): void;
  fail(error: unknown): void;
}
class FatalLobbyError extends Error {}

/** Serializes account funding and queue entry. Never treats payment balance as poker chips. */
export class LobbyLifecycle {
  private timer?: ReturnType<typeof setTimeout>;
  private operation: AbortController | null = null;
  private queued = false;
  private generation = 0;
  private rebuyNotBefore = 0;
  private recoveryAllowedAt = 0;
  private joinBackoffMs = 1000;
  constructor(
    private client: OpenPokerClient,
    private hooks: LobbyHooks,
  ) {}

  requestJoin(): void {
    if (!this.hooks.ready() || this.queued || this.operation) return;
    if (Date.now() < this.rebuyNotBefore) {
      this.schedule(this.rebuyNotBefore - Date.now());
      return;
    }
    void this.check(false);
  }
  departed(): void {
    this.queued = false;
  }
  seated(): void {
    this.cancel();
    this.queued = true;
    this.rebuyNotBefore = 0;
    this.recoveryAllowedAt = 0;
    this.joinBackoffMs = 1000;
  }
  resetSeason(): void {
    this.cancel();
    this.rebuyNotBefore = 0;
    this.recoveryAllowedAt = 0;
  }
  cancel(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.operation?.abort();
    this.operation = null;
    this.queued = false;
  }
  insufficientFunds(): void {
    this.queued = false;
    this.schedule(this.joinBackoffMs);
    this.joinBackoffMs = Math.min(30_000, this.joinBackoffMs * 2); // Reconcile available chips, never repeatedly request the configured amount.
  }
  busted(): void {
    this.queued = false;
    this.recoveryAllowedAt = Math.max(this.recoveryAllowedAt, Date.now() + 30_000);
    this.hooks.cooldown();
    this.schedule(1000);
  }
  scheduled(event: ServerEvent): void {
    if (!this.hooks.ready()) return;
    const detail = record(event.details);
    const seconds = Number(event.cooldown_seconds ?? detail.cooldown_seconds);
    const rawDate = event.rebuy_at ?? detail.rebuy_at;
    const date = typeof rawDate === 'string' ? Date.parse(rawDate) : NaN;
    const remaining = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300_000;
    this.rebuyNotBefore = Number.isFinite(date)
      ? Math.max(Date.now(), date)
      : Date.now() + remaining;
    this.recoveryAllowedAt = this.rebuyNotBefore;
    this.queued = false;
    this.hooks.cooldown();
    this.schedule(Math.max(1000, this.rebuyNotBefore - Date.now() + 250));
  }
  confirmed(): void {
    if (!this.hooks.ready() || this.queued) return;
    this.cancel();
    this.rebuyNotBefore = 0;
    this.recoveryAllowedAt = 0;
    this.requestJoin(); // Even if the event says 1500/2000, fetch the actual season balance.
  }
  private assertLease(): void {
    try {
      this.hooks.assertLease();
    } catch (error) {
      throw new FatalLobbyError(error instanceof Error ? error.message : String(error));
    }
  }
  private schedule(delay: number): void {
    if (!this.hooks.ready()) return;
    if (this.timer) clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation && this.hooks.ready() && !this.queued)
          void this.check(true);
      },
      Math.max(250, delay),
    );
  }
  private async check(recovery: boolean): Promise<void> {
    if (!this.hooks.ready() || this.operation || this.queued) return;
    if (Date.now() < this.rebuyNotBefore) {
      this.schedule(this.rebuyNotBefore - Date.now());
      return;
    }
    const operation = new AbortController();
    const generation = this.generation;
    this.operation = operation;
    const current = () =>
      this.hooks.ready() && generation === this.generation && !operation.signal.aborted;
    try {
      const season = await this.client.seasonBalance(operation.signal);
      if (!current()) return;
      if (season && season.chipsAtTable > 0 && season.chipBalance >= 1000) {
        const placement = await this.client.activeGame(operation.signal);
        if (!current()) return;
        if (placement.playing) this.hooks.recover(placement);
        else this.schedule(30_000);
        return;
      }
      if (season === null || season.chipBalance >= 1000) {
        this.assertLease();
        this.queued = true;
        this.hooks.join(
          season === null
            ? this.hooks.buyIn()
            : Math.min(this.hooks.buyIn(), season.chipBalance, 5000),
        );
        return;
      }
      if (!this.hooks.autoRebuy())
        throw new Error('Insufficient virtual chips and auto-rebuy is disabled');
      this.hooks.cooldown();
      this.hooks.send({ type: 'set_auto_rebuy', enabled: true });
      const active = await this.client.activeGame(operation.signal);
      if (!current()) return;
      if (active.playing) {
        if ((active.stack_chips ?? season.chipsAtTable) === 0) {
          this.hooks.send({ type: 'leave_table' });
          this.schedule(2000);
        } else this.hooks.recover(active);
        return;
      }
      if (season.chipsAtTable > 0) {
        this.schedule(30_000);
        return;
      }
      if (!recovery || Date.now() < this.recoveryAllowedAt) {
        this.recoveryAllowedAt = Math.max(this.recoveryAllowedAt, Date.now() + 30_000);
        this.schedule(30_000);
        return;
      }
      // Re-read both conditions immediately before the free rebuy. A competing server auto-rebuy
      // is harmless: its balance change makes this request ineligible and we reload instead.
      const [latest, placement] = await Promise.all([
        this.client.seasonBalance(operation.signal),
        this.client.activeGame(operation.signal),
      ]);
      if (!current()) return;
      if (!latest || placement.playing || latest.chipsAtTable > 0 || latest.chipBalance >= 1000) {
        this.schedule(1000);
        return;
      }
      this.assertLease();
      const result = await this.client.rebuy(operation.signal);
      if (!current()) return;
      if (result.status === 'cooldown') {
        this.rebuyNotBefore =
          Date.now() + Math.max(10_000, result.retryAfterMs ?? (latest.pro ? 120_000 : 300_000));
        this.recoveryAllowedAt = this.rebuyNotBefore;
        this.schedule(this.rebuyNotBefore - Date.now());
      } else {
        this.recoveryAllowedAt = Date.now() + 30_000;
        this.schedule(result.status === 'confirmed' ? 1000 : 30_000);
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof FatalLobbyError) this.hooks.fail(error);
      else if (error instanceof Error && /HTTP (401|403)/.test(error.message))
        this.hooks.fail(error);
      else if (error instanceof Error && error.message.includes('auto-rebuy is disabled'))
        this.hooks.fail(error);
      else {
        this.hooks.cooldown();
        this.schedule(30_000);
      }
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }
}
