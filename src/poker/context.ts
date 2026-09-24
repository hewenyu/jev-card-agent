import { buildContext } from '../core/context.js';
import type { OpponentMemory } from '../core/opponent-memory.js';
import { buildSession, type SessionTurn } from '../core/session.js';
import type { DecisionContext, OpponentStats, PokerState } from '../core/types.js';

export interface PokerContextHistory {
  previousTurns: SessionTurn[];
  opponents?: OpponentStats[];
  opponentMemory?: OpponentMemory[];
  asOf?: string | null;
  decisionId?: string;
}

/** Shared behavioral input for live play and each independent evaluation branch. */
export function buildPokerContext(
  state: PokerState,
  history: PokerContextHistory,
): DecisionContext {
  if (!state.tableId || !state.handId) throw new Error('Poker context requires a table and hand');
  const context = buildContext(
    state,
    history.opponents ?? [],
    history.asOf ? { asOf: history.asOf, recentOutcomes: [] } : undefined,
  );
  context.opponentMemory = structuredClone(
    (history.opponentMemory ?? []).filter((memory) =>
      state.seats.some(
        (seat) =>
          seat.name === memory.name &&
          seat.seat !== state.heroSeat &&
          seat.inHand !== false &&
          !seat.folded,
      ),
    ),
  );
  // Preserve live audit statuses, including failed/cancelled attempts with no action.
  context.session = buildSession(
    state.tableId,
    state.handId,
    history.decisionId ?? 'sdk-pending',
    history.previousTurns,
  );
  return context;
}
