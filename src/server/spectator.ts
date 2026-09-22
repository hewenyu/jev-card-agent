import type { ServerEvent } from '../openpoker/protocol.js';
import type { RuntimeView, SpectatorEvent, SpectatorSnapshot } from '../shared/api.js';

/** Whitelist public table fields; the owner explicitly publishes the agent’s own cards, never action authority. */
export function publicRuntime(view: RuntimeView): RuntimeView {
  const table = view.table;
  return {
    running: view.running,
    status: view.status,
    mode: view.mode,
    runId: view.runId,
    strategy: view.strategy,
    error: null,
    ...(view.research
      ? {
          research: {
            enabled: view.research.enabled,
            running: view.research.running,
            lastCompletedAt: view.research.lastCompletedAt,
            eventCursor: view.research.eventCursor,
            decisionCursor: view.research.decisionCursor,
            pendingHands: view.research.pendingHands,
            pendingAudits: view.research.pendingAudits,
            latestVersion: view.research.latestVersion,
            error: view.research.error ? 'Knowledge worker unavailable' : null,
          },
        }
      : {}),
    ...(view.funding
      ? {
          funding: {
            availableChips: view.funding.availableChips,
            chipsAtTable: view.funding.chipsAtTable,
            seasonScore: view.funding.seasonScore ?? null,
            seasonId: view.funding.seasonId ?? null,
            autoRebuy: view.funding.autoRebuy,
            rebuyAmount: view.funding.rebuyAmount,
            rebuyCooldownSeconds: view.funding.rebuyCooldownSeconds,
            rebuyAvailableAt: view.funding.rebuyAvailableAt,
            lastRebuyAt: view.funding.lastRebuyAt,
            updatedAt: view.funding.updatedAt,
            observedAt: view.funding.observedAt,
            status: view.funding.status,
          },
        }
      : {}),
    decision:
      view.decision &&
      view.decision.handId === table?.handId &&
      view.decision.tableId === table?.tableId
        ? {
            id: view.decision.id,
            sessionId: view.decision.sessionId,
            tableId: view.decision.tableId,
            handId: view.decision.handId,
            phase: view.decision.phase,
            startedAt: view.decision.startedAt,
            updatedAt: view.decision.updatedAt,
          }
        : null,
    table: table
      ? {
          tableId: table.tableId,
          handId: table.handId,
          street: table.street,
          pot: table.pot,
          board: table.board.slice(0, 5),
          heroCards: table.heroCards.slice(0, 2),
          heroSeat: table.heroSeat,
          dealerSeat: table.dealerSeat,
          actorSeat: table.actorSeat ?? null,
          stateSeq: table.stateSeq,
          complete: table.complete,
          seats: table.seats.slice(0, 6).map((seat) => ({
            seat: seat.seat,
            name: seat.name.slice(0, 100),
            stack: seat.stack,
            bet: seat.bet,
            folded: seat.folded,
            status: seat.status,
          })),
        }
      : null,
  };
}

const seatNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 6;
const chips = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const actions = new Set(['fold', 'check', 'call', 'raise', 'all_in', 'post_sb', 'post_bb', 'ante']);
const eventTypes = new Set(['hand_start', 'player_action', 'hand_result']);

/** One in-memory feed per controller, never a second connection to OpenPoker. */
export class SpectatorFeed {
  private sequence = 0;
  private scope = '';
  private watermark = -1;
  private actionIds = new Set<string>();
  private events: SpectatorEvent[] = [];
  private snapshot: SpectatorSnapshot;
  private readonly listeners = new Set<(snapshot: SpectatorSnapshot) => void>();
  constructor(view: RuntimeView) {
    this.snapshot = {
      sequence: this.sequence,
      observedAt: new Date().toISOString(),
      runtime: publicRuntime(view),
      recentEvents: [],
    };
  }
  get subscriberCount(): number {
    return this.listeners.size;
  }
  current(): SpectatorSnapshot {
    return structuredClone(this.snapshot);
  }
  subscribe(listener: (snapshot: SpectatorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.listeners.clear();
  }
  update(view: RuntimeView, incoming: readonly ServerEvent[] = []): void {
    const runtime = publicRuntime(view);
    const table = runtime.table;
    const scope = JSON.stringify([view.runId, table?.tableId, table?.handId]);
    if (scope !== this.scope) {
      this.scope = scope;
      this.events = [];
      this.watermark = -1;
      this.actionIds.clear();
    }
    if (view.running && table?.tableId && table.handId) {
      for (const event of incoming) {
        if (
          !eventTypes.has(event.type) ||
          event.table_id !== table.tableId ||
          event.hand_id !== table.handId ||
          typeof event.table_seq !== 'number' ||
          event.table_seq <= this.watermark ||
          event.table_seq > (table.stateSeq ?? -1)
        )
          continue;
        this.watermark = event.table_seq;
        const actionId = event.action_id ?? event.client_action_id;
        if (event.type === 'player_action' && typeof actionId === 'string') {
          if (this.actionIds.has(actionId)) continue;
          this.actionIds.add(actionId);
          if (this.actionIds.size > 512)
            this.actionIds.delete(this.actionIds.values().next().value!);
        }
        const id = `${view.runId}:${table.tableId}:${table.handId}:${event.table_seq}:${event.type}`;
        const projected: SpectatorEvent = {
          id,
          tableId: table.tableId,
          handId: table.handId,
          at: new Date().toISOString(),
          type: event.type,
          movements: [],
        };
        if (seatNumber(event.seat)) projected.seat = event.seat;
        if (typeof event.action === 'string' && actions.has(event.action))
          projected.action = event.action;
        if (
          event.type === 'player_action' &&
          seatNumber(event.seat) &&
          ['call', 'raise', 'all_in'].includes(String(event.action))
        ) {
          const amount = chips(event.contribution_delta)
            ? event.contribution_delta
            : chips(event.stack_before) && chips(event.stack_after)
              ? event.stack_before - event.stack_after
              : 0;
          if (chips(amount) && amount > 0)
            projected.movements.push({
              id: `${id}:in:${event.seat}`,
              tableId: table.tableId,
              handId: table.handId,
              seat: event.seat,
              amount,
              direction: 'to-pot',
            });
        }
        if (event.type === 'hand_result' && Array.isArray(event.payouts)) {
          for (const [index, payout] of event.payouts.slice(0, 36).entries()) {
            if (
              payout &&
              typeof payout === 'object' &&
              seatNumber(payout.seat) &&
              chips(payout.amount) &&
              payout.amount > 0
            )
              projected.movements.push({
                id: `${id}:out:${index}:${payout.seat}`,
                tableId: table.tableId,
                handId: table.handId,
                seat: payout.seat,
                amount: payout.amount,
                direction: 'from-pot',
              });
          }
        }
        this.events.push(projected);
      }
    }
    this.events = this.events.slice(-32);
    this.snapshot = {
      sequence: ++this.sequence,
      observedAt: new Date().toISOString(),
      runtime,
      recentEvents: this.events,
    };
    for (const listener of this.listeners) listener(this.current());
  }
}
