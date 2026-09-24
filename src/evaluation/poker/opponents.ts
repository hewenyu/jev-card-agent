import { analyzePokerCards } from '../../core/poker-cards.js';
import type { Candidate, PokerState } from '../../core/types.js';

export const OPPONENT_SUITE_VERSION = 'six-max-scripted-population-v1';
type Style = 'tight_value' | 'loose_passive' | 'balanced' | 'pressure' | 'selective_bluff';
export const OPPONENT_SUITES: Readonly<Record<string, readonly Style[]>> = Object.freeze({
  'mixed-v1': Object.freeze([
    'tight_value',
    'loose_passive',
    'balanced',
    'pressure',
    'selective_bluff',
  ] as const),
  'value-heavy-v1': Object.freeze([
    'tight_value',
    'balanced',
    'tight_value',
    'loose_passive',
    'balanced',
  ] as const),
  'pressure-heavy-v1': Object.freeze([
    'pressure',
    'selective_bluff',
    'balanced',
    'pressure',
    'tight_value',
  ] as const),
});

/** Versioned benchmark opponents use exactly the same visibility boundary as hero. */
export function opponentAction(
  style: Style,
  state: PokerState,
  candidates: Candidate[],
  random: () => number,
): Candidate {
  const facts = analyzePokerCards(state.holeCards, state.board);
  if (!facts || !candidates.length) throw new Error('Invalid opponent observation');
  const hero = state.seats.find((seat) => seat.seat === state.heroSeat)!;
  const maximum = Math.max(...state.seats.filter((seat) => !seat.folded).map((seat) => seat.bet));
  const toCall = Math.min(hero.stack, Math.max(0, maximum - hero.bet));
  const price = toCall / (state.pot + toCall || 1);
  const [high, low] = facts.hole.ranks as [number, number];
  const preflop =
    (high + low) / 28 +
    (facts.hole.pair ? 0.35 : 0) +
    (facts.hole.suited ? 0.08 : 0) -
    (high - low > 4 ? 0.12 : 0);
  const postflop = facts.madeHand?.category ?? 0;
  const strength =
    state.street === 'preflop'
      ? preflop
      : Math.min(
          1.4,
          postflop >= 4
            ? 1.3
            : postflop === 3
              ? 1.1
              : postflop === 2
                ? 0.85
                : postflop === 1
                  ? facts.relativeStrength.overpair || facts.relativeStrength.topPair
                    ? 0.8
                    : 0.5
                  : 0.15 +
                    (facts.draws.flushCompletionCards.length ||
                    facts.draws.straightCompletionCards.length
                      ? 0.3
                      : 0),
        );
  const aggression = {
    tight_value: 0.15,
    loose_passive: 0.05,
    balanced: 0.28,
    pressure: 0.6,
    selective_bluff: 0.38,
  }[style];
  const threshold = {
    tight_value: 0.82,
    loose_passive: 0.42,
    balanced: 0.62,
    pressure: 0.5,
    selective_bluff: 0.68,
  }[style];
  const draw = random();
  const raises = candidates.filter((candidate) => candidate.action === 'raise');
  const aggressive =
    raises[
      Math.min(raises.length - 1, Math.floor(raises.length * (style === 'pressure' ? 0.65 : 0.35)))
    ];
  if (
    aggressive &&
    (strength > 1 ||
      (strength >= threshold && draw < aggression) ||
      (style === 'selective_bluff' && draw < 0.09))
  )
    return aggressive;
  const check = candidates.find((candidate) => candidate.action === 'check');
  if (check) return check;
  const call = candidates.find((candidate) => candidate.action === 'call');
  if (call && strength >= threshold + Math.max(0, price - 0.2)) return call;
  return candidates.find((candidate) => candidate.action === 'fold') ?? candidates[0]!;
}
