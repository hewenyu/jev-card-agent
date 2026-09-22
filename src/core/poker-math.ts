import type { DecisionContext, PokerState, Seat } from './types.js';

type Situation = Pick<
  DecisionContext,
  'seats' | 'heroSeat' | 'dealerSeat' | 'pot' | 'toCall' | 'bigBlind'
>;
export const round = (value: number): number => Math.round(value * 10000) / 10000;
export const activeSeats = (seats: Seat[]): Seat[] =>
  seats.filter((seat) => seat.name !== null && seat.inHand !== false && !seat.folded);

/** Server call prices take precedence. The all-in-only case still has a price. */
export function callAmount(state: PokerState): number {
  const hero = state.seats.find((seat) => seat.seat === state.heroSeat);
  const call = state.validActions.find((action) => action.action === 'call');
  if (call?.amount !== undefined) return Math.min(call.amount, hero?.stack ?? call.amount);
  if (state.validActions.some((action) => action.action === 'check')) return 0;
  if (!hero) return 0;
  const wager = Math.max(0, ...activeSeats(state.seats).map((seat) => seat.bet));
  return Math.min(hero.stack, Math.max(0, wager - hero.bet));
}

export function positionFacts(context: Situation) {
  const occupied = context.seats
    .filter((seat) => seat.name !== null)
    .sort((a, b) => a.seat - b.seat);
  const button = occupied.findIndex((seat) => seat.seat === context.dealerSeat);
  if (button < 0 || occupied.length < 2) return { hero: null, seats: [], lastToActPostflop: null };
  const clockwise = [...occupied.slice(button), ...occupied.slice(0, button)];
  const labels =
    clockwise.length === 2
      ? ['BTN/SB', 'BB']
      : clockwise.length === 3
        ? ['BTN', 'SB', 'BB']
        : clockwise.length === 4
          ? ['BTN', 'SB', 'BB', 'CO']
          : clockwise.length === 5
            ? ['BTN', 'SB', 'BB', 'HJ', 'CO']
            : ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'];
  const seats = clockwise.map((seat, index) => ({
    seat: seat.seat,
    position: labels[index] ?? null,
  }));
  const acting = [...clockwise.slice(1), clockwise[0]!].filter(
    (seat) => seat.inHand !== false && !seat.folded && seat.stack > 0,
  );
  return {
    hero: seats.find((seat) => seat.seat === context.heroSeat)?.position ?? null,
    seats,
    lastToActPostflop: acting.at(-1)?.seat ?? null,
  };
}

export function bettingFacts(context: Situation) {
  const hero = context.seats.find((seat) => seat.seat === context.heroSeat);
  const opponents = activeSeats(context.seats).filter((seat) => seat.seat !== context.heroSeat);
  const call = Math.min(context.toCall, hero?.stack ?? context.toCall);
  const target = (hero?.bet ?? 0) + call;
  // The pot contains opponents' entire current wagers, including amounts hero cannot cover.
  const inaccessible =
    hero && call === hero.stack && call > 0
      ? context.seats.reduce((sum, seat) => sum + Math.max(0, seat.bet - target), 0)
      : 0;
  const contestable = Math.max(0, context.pot - inaccessible);
  const threshold = call > 0 && contestable + call > 0 ? round(call / (contestable + call)) : null;
  const sidePotsPossible =
    opponents.length > 1 &&
    ((call > 0 && call === hero?.stack) || opponents.some((seat) => seat.stack === 0));
  return {
    potChips: context.pot,
    heroStackChips: hero?.stack ?? null,
    heroStreetBetChips: hero?.bet ?? null,
    callChips: call,
    callConsumesStack: call > 0 && call === hero?.stack,
    inaccessibleCurrentWagersChips: inaccessible,
    contestablePotBeforeCallChips: contestable,
    requiredEquityToCall: threshold,
    priceQualification: sidePotsPossible
      ? 'Aggregate price reference only: unequal multiway side pots need separate equities and eligibility; not a single-pot EV.'
      : 'Break-even showdown share if betting ends after calling; excludes future bets and rake.',
    sidePotsPossible,
    activeOpponents: opponents.length,
    potBb: context.bigBlind > 0 ? round(context.pot / context.bigBlind) : null,
    heroStackBb: hero && context.bigBlind > 0 ? round(hero.stack / context.bigBlind) : null,
    opponents: opponents.map((seat) => {
      // Include money already pushed into this street; an all-in opponent still covers a call.
      const effective = hero ? Math.min(hero.stack + hero.bet, seat.stack + seat.bet) : null;
      return {
        seat: seat.seat,
        stackChips: seat.stack,
        streetBetChips: seat.bet,
        allIn: seat.stack === 0,
        effectiveStreetTotalChips: effective,
        additionalHeroChipsAtRisk: effective === null ? null : Math.max(0, effective - hero!.bet),
        effectiveBb:
          effective !== null && context.bigBlind > 0 ? round(effective / context.bigBlind) : null,
        remainingSprAfterCall:
          hero && contestable + call > 0
            ? round(Math.min(Math.max(0, hero.stack - call), seat.stack) / (contestable + call))
            : null,
      };
    }),
  };
}
