import type { HandDetail, TableView } from '../../src/shared/api';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stringCards = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((card): card is string => typeof card === 'string') : [];
const numeric = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const chips = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

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
    complete: false,
  };
  let observedHandId: string | null = null;
  let observedTableId = detail.hand.tableId;
  let tableSequence = -1;
  const visibleEvents = detail.events.slice(0, cursor + 1).flatMap((event) => {
    if (event.type !== 'resync_response' || !Array.isArray(event.payload.replayed_events))
      return [event];
    // The envelope is stored before its replay rows. Apply its replay first, then
    // install the final snapshot; later duplicate rows cannot add chips again.
    const replay = event.payload.replayed_events
      .map(record)
      .filter((payload) => typeof payload.type === 'string')
      .sort((a, b) => (chips(a.table_seq) ?? 0) - (chips(b.table_seq) ?? 0))
      .map((payload) => ({ ...event, type: String(payload.type), payload }));
    return [...replay, event];
  });
  for (const event of visibleEvents) {
    const payload = event.payload;
    const snapshot = record(payload.snapshot);
    const data = Object.keys(snapshot).length ? snapshot : payload;
    const hero = record(data.hero);
    const tableId = typeof data.table_id === 'string' ? data.table_id : payload.table_id;
    if (typeof tableId === 'string' && tableId !== observedTableId) {
      observedTableId = tableId;
      observedHandId = null;
      tableSequence = -1;
      table.dealerSeat = null;
    }
    const sequence = chips(
      event.type === 'resync_response'
        ? (payload.to_table_seq ?? payload.table_seq ?? data.table_seq)
        : payload.table_seq,
    );
    if (
      sequence !== undefined &&
      (event.type === 'resync_response' ? sequence < tableSequence : sequence <= tableSequence)
    )
      continue;
    if (sequence !== undefined) tableSequence = sequence;
    const previousStreet = table.street;
    if (typeof data.street === 'string') table.street = data.street;
    if (event.type === 'hand_start') {
      table.street = 'preflop';
      table.complete = false;
      table.seats = table.seats.map((seat) => ({ ...seat, bet: 0 }));
    }
    if (event.type === 'your_turn' && Array.isArray(data.community_cards)) {
      const count = data.community_cards.length;
      table.street =
        count === 5 ? 'river' : count === 4 ? 'turn' : count === 3 ? 'flop' : 'preflop';
    }
    if (table.street !== previousStreet)
      table.seats = table.seats.map((seat) => ({ ...seat, bet: 0 }));
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
    if (typeof data.hand_id === 'string' && data.hand_id !== observedHandId) {
      table.complete = false;
      table.dealerSeat = null;
    }
    if (event.type === 'hand_start' || event.type === 'table_closed') table.dealerSeat = null;
    if (typeof data.hand_id === 'string') observedHandId = data.hand_id;
    if ('dealer_seat' in data || 'dealerSeat' in data) {
      const dealer = 'dealer_seat' in data ? data.dealer_seat : data.dealerSeat;
      table.dealerSeat =
        typeof dealer === 'number' && Number.isInteger(dealer) && dealer >= 0 && dealer < 6
          ? dealer
          : null;
    }
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
      if (player) {
        const stack =
          chips(data.stack_after) ??
          chips(data.player_stack_after) ??
          chips(data.stack) ??
          player.stack;
        const delta = chips(data.contribution_delta) ?? Math.max(0, player.stack - stack);
        player.bet = chips(data.bet) ?? player.bet + delta;
        player.stack = stack;
      }
      const pot = chips(data.pot_after);
      if (pot !== undefined) {
        table.pot = pot;
        table.potKnown = true;
      }
    }
    if (event.type === 'hand_result') {
      table.complete = true;
      const pot = chips(data.total_pot) ?? chips(data.pot);
      if (pot !== undefined) {
        table.pot = pot;
        table.potKnown = true;
      }
      const stacks = record(data.final_stacks);
      for (const player of table.seats) {
        const finalStack = stacks[String(player.seat)];
        if (typeof finalStack === 'number') player.stack = finalStack;
        player.bet = 0;
      }
    }
  }
  return table;
}
