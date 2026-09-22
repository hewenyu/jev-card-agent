import { opponentKey } from '../knowledge/advice-validator.js';
type Raw = Record<string, unknown>;
const object = (value: unknown): Raw =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const seatNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 6 ? value : null;
export interface ResearchRoster {
  opponentSeats: Map<string, number>;
  excludedSeats: number[];
}
/** A final seat snapshot cannot retroactively identify the actor of every action in the hand. */
export function researchRoster(
  contexts: Raw[],
  events: Array<{ type: string; payload: Raw }>,
): ResearchRoster {
  const names = new Map<number, Set<string>>();
  const heroSeats = new Set<number>();
  const excluded = new Set<number>();
  const waitingOnly = new Set<number>();
  const participated = new Set<number>();
  const observe = (seat: Raw) => {
    const index = seatNumber(seat.seat);
    if (index === null || typeof seat.name !== 'string' || !seat.name) return;
    const seen = names.get(index) ?? new Set<string>();
    seen.add(seat.name);
    names.set(index, seen);
    const membership = seat.inHand ?? seat.in_hand;
    if (membership === true) participated.add(index);
    if (membership === false) waitingOnly.add(index);
  };
  for (const context of contexts) {
    const hero = seatNumber(context.heroSeat);
    if (hero !== null) heroSeats.add(hero);
    array(context.seats).map(object).forEach(observe);
    array(context.history)
      .map(object)
      .filter((action) => !action.handId || !context.handId || action.handId === context.handId)
      .forEach(observe);
  }
  for (const event of events) {
    if (
      event.type === 'table_state' ||
      event.type === 'table_joined' ||
      event.type === 'hand_start'
    ) {
      const hero = seatNumber(object(event.payload.hero).seat);
      if (hero !== null) heroSeats.add(hero);
      array(event.payload.seats).map(object).forEach(observe);
    }
    if (event.type === 'player_joined') {
      observe(event.payload);
      const seat = seatNumber(event.payload.seat);
      // A mid-hand arrival without explicit participation waits; never attribute earlier actions to it.
      if (seat !== null && event.payload.in_hand !== true) excluded.add(seat);
    }
    if (event.type === 'player_left') {
      const seat = seatNumber(event.payload.seat);
      if (seat !== null) excluded.add(seat);
    }
  }
  for (const [seat, seen] of names)
    if (seen.size !== 1 || (waitingOnly.has(seat) && !participated.has(seat))) excluded.add(seat);
  // A name appearing in multiple seats cannot provide a unique public-name identity for this hand.
  const keyed = new Map<string, number[]>();
  for (const [seat, seen] of names)
    for (const name of seen) {
      const key = opponentKey(name);
      keyed.set(key, [...(keyed.get(key) ?? []), seat]);
    }
  for (const seats of keyed.values())
    if (seats.length > 1) seats.forEach((seat) => excluded.add(seat));
  if (heroSeats.size !== 1) for (const seat of names.keys()) excluded.add(seat);
  const opponentSeats = new Map<string, number>();
  for (const [seat, seen] of names)
    if (!excluded.has(seat) && !heroSeats.has(seat))
      opponentSeats.set(opponentKey([...seen][0]!), seat);
  return { opponentSeats, excludedSeats: [...excluded].sort((a, b) => a - b) };
}
