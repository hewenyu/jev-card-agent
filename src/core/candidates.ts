import type { Candidate, PokerState } from './types.js';

export const CANDIDATE_VERSION = 'legal-raise-to-v1';
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
  const toCall = state.validActions.find((a) => a.action === 'call')?.amount ?? 0;
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
    const targets = [
      legal.min,
      ...[0.5, 1].map((f) => currentTotal + Math.round((state.pot + toCall) * f)),
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
