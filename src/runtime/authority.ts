import { createHash } from 'node:crypto';
import type { PokerState } from '../core/types.js';
import type { StoredAction } from './types.js';

export function authorityKey(state: PokerState): string {
  return JSON.stringify([state.tableId, state.handId, state.turnToken]);
}

export function actionAuthorityKey(action: StoredAction): string {
  return JSON.stringify([action.tableId, action.payload.hand_id, action.payload.turn_token]);
}

/** Sequence, timestamps and off-table balances cannot invalidate an otherwise identical turn. */
export function decisionStateKey(state: PokerState, includeHistory = true): string {
  const {
    tableId,
    handId,
    turnToken,
    heroSeat,
    dealerSeat,
    actorSeat,
    street,
    pot,
    board,
    holeCards,
    smallBlind,
    bigBlind,
    validActions,
    complete,
    historyIncomplete,
  } = state;
  return createHash('sha256')
    .update(
      JSON.stringify({
        tableId,
        handId,
        turnToken,
        heroSeat,
        dealerSeat,
        actorSeat,
        street,
        pot,
        board,
        holeCards,
        smallBlind,
        bigBlind,
        validActions: validActions
          .map(({ action, amount, min, max }) => ({ action, amount, min, max }))
          .sort((a, b) => a.action.localeCompare(b.action)),
        complete,
        ...(includeHistory ? { historyIncomplete } : {}),
        seats: state.seats
          .filter(
            (seat) =>
              seat.seat === heroSeat ||
              (seat.name !== null && seat.inHand !== false && !seat.folded),
          )
          .sort((a, b) => a.seat - b.seat)
          .map(({ seat, name, stack, bet, status, inHand, folded }) => ({
            seat,
            name,
            stack,
            bet,
            // Connectivity can change mid-request without changing this player's hand eligibility.
            // Keep the raw status in PokerState/context; normalize only these known connection states.
            status: status === 'disconnected' ? 'active' : status,
            inHand,
            folded,
          })),
        history: (includeHistory ? state.history : []).map(
          ({ seat, name, action, street, amount, toCallBefore }) => ({
            seat,
            name,
            action,
            street,
            amount,
            toCallBefore,
          }),
        ),
      }),
    )
    .digest('hex');
}

export const runtimeDefaults = {
  buyIn: 2000,
  autoRebuy: true,
  maxHands: 0,
  maxDurationMs: 0,
  decisionTimeoutMs: 40_000,
  turnTimeoutMs: 45_000,
  submissionReserveMs: 1500,
  reconnectMinMs: 500,
  reconnectMaxMs: 15_000,
  maxReconnectAttempts: 20,
  gracefulStopTimeoutMs: 0,
};

export function validateStartOptions(options: typeof runtimeDefaults): void {
  if (!Number.isInteger(options.buyIn) || options.buyIn < 1000 || options.buyIn > 5000)
    throw new Error('Public buyIn must be an integer from 1000 to 5000');
  for (const key of [
    'maxHands',
    'maxDurationMs',
    'decisionTimeoutMs',
    'reconnectMinMs',
    'reconnectMaxMs',
    'maxReconnectAttempts',
  ] as const)
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`Invalid ${key}`);
}

export function atHandBoundary(state: PokerState): boolean {
  return (
    state.complete ||
    state.street === 'idle' ||
    [
      'between_hands_delay',
      'awaiting_hand_start',
      'insufficient_players',
      'table_closing',
    ].includes(state.waitingReason ?? '')
  );
}
