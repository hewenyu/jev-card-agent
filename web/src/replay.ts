import type { HandDetail, TableView } from '../../src/shared/api';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stringCards = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((card): card is string => typeof card === 'string') : [];
const numeric = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

// Build only from events visible at the cursor. Final hand metadata is never backfilled.
export function replayTable(detail: HandDetail, cursor: number): TableView & { potKnown: boolean } {
  const table: TableView & { potKnown: boolean } = {
    potKnown: false,
    tableId: detail.hand.tableId,
    handId: detail.hand.id,
    street: 'preflop',
    pot: 0,
    board: [],
    heroCards: [],
    heroSeat: null,
    dealerSeat: null,
    seats: [],
  };
  for (const event of detail.events.slice(0, cursor + 1)) {
    const payload = event.payload;
    const snapshot = record(payload.snapshot);
    const data = Object.keys(snapshot).length ? snapshot : payload;
    const hero = record(data.hero);
    if (typeof data.street === 'string') table.street = data.street;
    if (typeof data.pot === 'number') {
      table.pot = data.pot;
      table.potKnown = true;
    }
    if (typeof data.pot_chips === 'number') {
      table.pot = data.pot_chips;
      table.potKnown = true;
    }
    if (typeof data.heroSeat === 'number') table.heroSeat = data.heroSeat;
    if (typeof hero.seat === 'number') table.heroSeat = hero.seat;
    if (typeof data.dealer_seat === 'number') table.dealerSeat = data.dealer_seat;
    if (typeof data.dealerSeat === 'number') table.dealerSeat = data.dealerSeat;
    if (
      ['hand_start', 'table_joined', 'your_turn'].includes(event.type) &&
      typeof data.seat === 'number'
    )
      table.heroSeat = data.seat;
    const board = data.board ?? data.community_cards;
    if (Array.isArray(board)) table.board = stringCards(board);
    if (event.type === 'community_cards' && Array.isArray(data.cards)) {
      const cards = stringCards(data.cards);
      table.board = cards.length >= 3 ? cards : [...new Set([...table.board, ...cards])];
    }
    if (event.type === 'hole_cards') table.heroCards = stringCards(data.cards);
    if (Array.isArray(data.heroCards)) table.heroCards = stringCards(data.heroCards);
    if (Array.isArray(hero.hole_cards)) table.heroCards = stringCards(hero.hole_cards);
    if (Array.isArray(data.hole_cards)) table.heroCards = stringCards(data.hole_cards);
    if (Array.isArray(data.seats))
      table.seats = data.seats
        .map(record)
        .filter((seat) => typeof seat.seat === 'number' && typeof seat.name === 'string')
        .map((seat) => ({
          seat: numeric(seat.seat, 0),
          name: String(seat.name),
          stack: numeric(seat.stack ?? seat.stack_chips, 0),
          bet: numeric(seat.bet ?? seat.bet_chips, 0),
          folded: seat.folded === true || seat.status === 'folded',
          status: String(seat.status ?? 'active'),
        }));
    else if (Array.isArray(data.players)) {
      // your_turn carries public player summaries, not a full seat snapshot.
      // Missing bet/folded/status fields must not undo facts from earlier events.
      for (const player of data.players.map(record)) {
        if (typeof player.seat !== 'number') continue;
        const existing = table.seats.find((seat) => seat.seat === player.seat);
        if (!existing && typeof player.name !== 'string') continue;
        const next = {
          seat: player.seat,
          name: typeof player.name === 'string' ? player.name : existing!.name,
          stack: numeric(player.stack ?? player.stack_chips, existing?.stack ?? 0),
          bet: numeric(player.bet ?? player.bet_chips, existing?.bet ?? 0),
          folded:
            typeof player.folded === 'boolean'
              ? player.folded
              : typeof player.status === 'string'
                ? player.status === 'folded'
                : (existing?.folded ?? false),
          status:
            typeof player.status === 'string' ? player.status : (existing?.status ?? 'unknown'),
        };
        if (existing) Object.assign(existing, next);
        else table.seats.push(next);
      }
    }
    if (event.type === 'player_action') {
      const player = table.seats.find((seat) => seat.seat === data.seat);
      if (player && data.action === 'fold') player.folded = true;
      if (player && typeof data.stack === 'number') player.stack = data.stack;
      if (player && typeof data.bet === 'number') player.bet = data.bet;
    }
    if (event.type === 'hand_result') {
      const stacks = record(data.final_stacks);
      for (const player of table.seats) {
        const finalStack = stacks[String(player.seat)];
        if (typeof finalStack === 'number') player.stack = finalStack;
      }
    }
  }
  return table;
}
