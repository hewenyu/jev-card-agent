import type { DecisionContext, OpponentStats, PokerState } from './types.js';
import { summarizeRecentOutcomes, type HistoricalFeedback } from './history.js';
import { STRATEGY_VERSIONS } from './versions.js';

export function buildContext(
  state: PokerState,
  opponents: OpponentStats[] = [],
  feedback?: HistoricalFeedback,
): DecisionContext {
  const hero = state.seats.find((s) => s.seat === state.heroSeat);
  const active = state.seats.filter(
    (s) => s.seat !== state.heroSeat && s.name !== null && s.inHand !== false && !s.folded,
  );
  const toCall = state.validActions.find((a) => a.action === 'call')?.amount ?? 0;
  return structuredClone({
    version: STRATEGY_VERSIONS.context,
    strategyVersions: STRATEGY_VERSIONS,
    lastTableSeq: state.lastTableSeq,
    asOf: feedback?.asOf ?? null,
    recentOutcomes: feedback
      ? summarizeRecentOutcomes(feedback.recentOutcomes ?? [], feedback.asOf, state.handId)
      : [],
    tableId: state.tableId,
    handId: state.handId,
    street: state.street,
    heroSeat: state.heroSeat,
    dealerSeat: state.dealerSeat,
    pot: state.pot,
    board: state.board,
    holeCards: state.holeCards,
    seats: state.seats,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    toCall,
    potOdds: toCall > 0 ? toCall / (state.pot + toCall) : null,
    effectiveStack:
      hero && active.length > 0
        ? Math.min(hero.stack, Math.max(...active.map((s) => s.stack)))
        : null,
    history: state.history,
    opponents: opponents.filter((opponent) =>
      state.seats.some((seat) => seat.name === opponent.name && seat.seat !== state.heroSeat),
    ),
    historyIncomplete: state.historyIncomplete,
  });
}
