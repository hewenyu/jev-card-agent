import type { Candidate, PokerState } from './types.js';
import { callAmount } from './poker-math.js';

export const CANDIDATE_VERSION = 'street-sized-raise-to-v2';
export function validateCandidate(candidate: Candidate, state: PokerState): boolean {
  if (!state.turnToken || !state.handId || state.complete) return false;
  return state.validActions.some((legal) => {
    if (candidate.action !== legal.action) return false;
    if (candidate.action !== 'raise') return candidate.amount === undefined;
    return (
      candidate.amount !== undefined &&
      Number.isSafeInteger(candidate.amount) &&
      legal.min !== undefined &&
      legal.max !== undefined &&
      candidate.amount >= legal.min &&
      candidate.amount <= legal.max
    );
  });
}
export function buildCandidates(state: PokerState): Candidate[] {
  if (!state.turnToken || !state.handId || state.complete) return [];
  const heroBet = state.seats.find((s) => s.seat === state.heroSeat)?.bet ?? 0;
  const toCall = callAmount(state);
  const candidates: Candidate[] = [];
  for (const legal of state.validActions) {
    if (legal.action !== 'raise') {
      candidates.push({
        id: legal.action,
        action: legal.action,
        label: legal.action === 'call' ? `Call ${toCall}` : legal.action.replace('_', ' '),
      });
      continue;
    }
    if (legal.min === undefined || legal.max === undefined) continue;
    const currentTotal = heroBet + toCall;
    const limpers = new Set(
      state.history
        .filter(
          (h) =>
            h.street === 'preflop' &&
            h.action === 'call' &&
            h.seat !== state.heroSeat &&
            !state.history.some((entry) => entry.street === 'preflop' && entry.action === 'raise'),
        )
        .map((h) => h.seat),
    ).size;
    const sizes =
      state.street === 'preflop'
        ? currentTotal <= state.bigBlind
          ? [2.2, 2.5, 3 + limpers].map((multiple) => Math.round(multiple * state.bigBlind))
          : [2.5, 3.5].map((multiple) => Math.round(multiple * currentTotal))
        : [1 / 3, 0.5, 2 / 3, 1].map(
            (fraction) => currentTotal + Math.round((state.pot + toCall) * fraction),
          );
    const targets = [
      legal.min,
      ...sizes,
      // Preserve an intermediate wager when pot-sized targets all exceed a short stack.
      ...(state.street !== 'preflop' && sizes.every((size) => size >= legal.max!)
        ? [currentTotal + Math.round((legal.max - currentTotal) / 2)]
        : []),
      legal.max,
    ];
    for (const target of targets) {
      const amount = Math.max(legal.min, Math.min(legal.max, target));
      // A max raise duplicates all-in only when the current street contribution proves it.
      const hero = state.seats.find((s) => s.seat === state.heroSeat);
      if (
        hero &&
        amount === hero.bet + hero.stack &&
        state.validActions.some((a) => a.action === 'all_in')
      )
        continue;
      candidates.push({
        id: `raise_to_${amount}`,
        action: 'raise',
        amount,
        label: `Raise to ${amount}`,
      });
    }
  }
  return [
    ...new Map(
      candidates.filter((c) => validateCandidate(c, state)).map((c) => [c.id, c]),
    ).values(),
  ];
}
