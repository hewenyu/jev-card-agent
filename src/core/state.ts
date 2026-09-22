import type {
  Action,
  HistoryEntry,
  PokerState,
  RawMessage,
  Seat,
  Street,
  ValidAction,
} from './types.js';

export function record(value: unknown): RawMessage {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawMessage)
    : {};
}
export function chips(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const dealerSeat = (message: RawMessage, previous: number | null): number | null => {
  if (!('dealer_seat' in message)) return previous;
  const seat = chips(message.dealer_seat);
  return seat !== undefined && seat < 6 ? seat : null;
};
const cards = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((c) => typeof c === 'string' && /^[2-9TJQKA][hdcs]$/.test(c))
    ? (value as string[])
    : undefined;
const streets: Street[] = ['idle', 'preflop', 'flop', 'turn', 'river'];
const actions: Action[] = ['fold', 'check', 'call', 'raise', 'all_in'];
const street = (value: unknown): Street | undefined =>
  streets.includes(value as Street) ? (value as Street) : undefined;
export function parseValidActions(value: unknown): ValidAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const a = record(item);
    if (!actions.includes(a.action as Action)) return [];
    if (
      a.action === 'raise' &&
      (chips(a.min) === undefined || chips(a.max) === undefined || Number(a.min) > Number(a.max))
    )
      return [];
    return [
      { action: a.action as Action, amount: chips(a.amount), min: chips(a.min), max: chips(a.max) },
    ];
  });
}
export function createInitialState(): PokerState {
  return {
    tableId: null,
    handId: null,
    heroSeat: null,
    dealerSeat: null,
    actorSeat: null,
    street: 'idle',
    pot: 0,
    board: [],
    holeCards: [],
    seats: [],
    smallBlind: 10,
    bigBlind: 20,
    validActions: [],
    turnToken: null,
    lastTableSeq: -1,
    history: [],
    handStartStacks: {},
    complete: false,
    historyIncomplete: false,
    waitingReason: null,
  };
}
function newHand(state: PokerState, handId: string, knownStart: boolean): PokerState {
  return {
    ...state,
    handId,
    dealerSeat: null,
    street: 'preflop',
    board: [],
    holeCards: [],
    history: [],
    pot: 0,
    turnToken: null,
    validActions: [],
    complete: false,
    historyIncomplete: !knownStart,
    waitingReason: null,
    handStartStacks: knownStart
      ? Object.fromEntries(state.seats.filter((s) => s.name !== null).map((s) => [s.seat, s.stack]))
      : {},
    seats: state.seats.map((s) => ({ ...s, bet: 0, folded: undefined, inHand: undefined })),
  };
}
function parseSeats(value: unknown, previous: Seat[], authoritative: boolean): Seat[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const updates = value.flatMap((item) => {
    const s = record(item);
    const seat = chips(s.seat);
    if (seat === undefined) return [];
    const previousSeat = previous.find((p) => p.seat === seat);
    const name =
      string(s.name) ??
      (!authoritative && s.name === undefined ? (previousSeat?.name ?? null) : null);
    const old = previousSeat?.name === name ? previousSeat : undefined;
    return [
      {
        seat,
        name,
        stack: chips(s.stack) ?? old?.stack ?? 0,
        bet: chips(s.bet) ?? (authoritative ? 0 : (old?.bet ?? 0)),
        status: string(s.status) ?? old?.status ?? (name === null ? 'empty' : 'active'),
        inHand:
          typeof s.in_hand === 'boolean' ? s.in_hand : authoritative ? undefined : old?.inHand,
        folded:
          typeof s.folded === 'boolean'
            ? s.folded
            : s.in_hand === false || (authoritative && s.in_hand !== true)
              ? undefined
              : old?.folded,
      },
    ];
  });
  if (authoritative) return updates;
  // your_turn contains a player summary, not an authoritative occupancy snapshot.
  const seats = new Map(previous.map((seat) => [seat.seat, seat]));
  for (const seat of updates) seats.set(seat.seat, seat);
  return [...seats.values()].sort((a, b) => a.seat - b.seat);
}
function snapshot(state: PokerState, message: RawMessage, authority: boolean): PokerState {
  const hero = record(message.hero);
  const heroSeat = chips(hero.seat) ?? state.heroSeat;
  const actorSeat = chips(message.actor_seat) ?? null;
  const validActions = 'valid_actions' in hero ? parseValidActions(hero.valid_actions) : [];
  const token =
    authority &&
    heroSeat !== null &&
    (actorSeat === null || actorSeat === heroSeat) &&
    validActions.length > 0
      ? (string(hero.turn_token) ?? null)
      : null;
  const retainsAuthority =
    !authority && state.turnToken !== null && actorSeat === heroSeat && validActions.length > 0;
  return {
    ...state,
    heroSeat,
    actorSeat: token ? heroSeat : actorSeat,
    street: street(message.street) ?? state.street,
    dealerSeat: dealerSeat(message, state.dealerSeat),
    smallBlind: chips(message.small_blind) ?? state.smallBlind,
    bigBlind: chips(message.big_blind) ?? state.bigBlind,
    pot: chips(message.pot) ?? state.pot,
    board: cards(message.board) ?? state.board,
    holeCards: cards(hero.hole_cards) ?? state.holeCards,
    seats: parseSeats(message.seats, state.seats, true) ?? state.seats,
    validActions,
    turnToken: token ?? (retainsAuthority ? state.turnToken : null),
    waitingReason: string(message.waiting_reason) ?? null,
  };
}
function applyAction(state: PokerState, message: RawMessage): PokerState {
  const seat = chips(message.seat);
  if (seat === undefined || !actions.includes(message.action as Action)) return state;
  const action = message.action as Action;
  const actionId = string(message.action_id) ?? string(message.client_action_id) ?? null;
  if (actionId && state.history.some((h) => h.actionId === actionId)) return state;
  // OpenPoker can report the next street on the action that closes this one.
  // Only a matching actor snapshot proves which street the action belonged to.
  const knownActionStreet = state.actorSeat === seat && state.street !== 'idle';
  const historyEntry: HistoryEntry = {
    handId: state.handId,
    tableSeq: chips(message.table_seq) ?? null,
    seat,
    name: string(message.name) ?? state.seats.find((s) => s.seat === seat)?.name ?? null,
    action,
    street: knownActionStreet ? state.street : (street(message.street) ?? state.street),
    reportedStreet: string(message.street) ?? null,
    streetSource: knownActionStreet ? 'pre_action_state' : 'event',
    amount: chips(message.amount) ?? null,
    toCallBefore: chips(message.to_call_before) ?? null,
    actionId,
    timestamp: string(message.ts) ?? null,
  };
  return {
    ...state,
    history: [...state.history, historyEntry],
    pot: chips(message.pot_after) ?? chips(message.pot) ?? state.pot,
    seats: state.seats.map((s) => {
      if (s.seat !== seat) return s;
      const stack =
        chips(message.stack_after) ??
        chips(message.player_stack_after) ??
        chips(message.stack) ??
        s.stack;
      const delta = chips(message.contribution_delta) ?? (s.stack >= stack ? s.stack - stack : 0);
      return { ...s, stack, bet: s.bet + delta, folded: action === 'fold' ? true : s.folded };
    }),
    turnToken: null,
    validActions: [],
  };
}
/** Pure V2 reducer. A sequence gap is not evidence that this recipient missed an event. */
export function reduceMessage(previous: PokerState, message: RawMessage): PokerState {
  const type = string(message.type);
  const tableId =
    string(message.table_id) ??
    (type === 'resync_response' ? string(record(message.snapshot).table_id) : undefined);
  const differentTable = tableId !== undefined && tableId !== previous.tableId;
  let state = differentTable
    ? { ...createInitialState(), tableId, heroSeat: previous.heroSeat }
    : previous;
  const sequence = chips(message.table_seq);
  if (type !== 'resync_response' && sequence !== undefined && sequence <= state.lastTableSeq)
    return state;
  if (type === 'resync_response') {
    const watermark = chips(message.to_table_seq) ?? sequence;
    if (watermark !== undefined && watermark < state.lastTableSeq) return state;
    const replay = Array.isArray(message.replayed_events)
      ? message.replayed_events.map(record)
      : [];
    replay.sort((a, b) => (chips(a.table_seq) ?? 0) - (chips(b.table_seq) ?? 0));
    for (const event of replay) state = reduceMessage(state, event);
    const final = record(message.snapshot);
    const handId = string(final.hand_id) ?? string(message.hand_id);
    if (handId && handId !== state.handId) state = newHand(state, handId, false);
    state = snapshot(state, final, message.role !== 'spectator');
    if (message.role === 'spectator')
      state = { ...state, heroSeat: null, holeCards: [], validActions: [], turnToken: null };
    return {
      ...state,
      tableId: string(final.table_id) ?? tableId ?? state.tableId,
      lastTableSeq: Math.max(state.lastTableSeq, watermark ?? -1),
    };
  }
  const handId = string(message.hand_id);
  if (handId && handId !== state.handId) state = newHand(state, handId, type === 'hand_start');
  if (sequence !== undefined) state = { ...state, lastTableSeq: sequence };
  switch (type) {
    case 'table_joined':
      return {
        ...state,
        tableId: tableId ?? state.tableId,
        heroSeat: chips(message.seat) ?? state.heroSeat,
        dealerSeat: dealerSeat(message, state.dealerSeat),
        seats: parseSeats(message.players, state.seats, true) ?? state.seats,
      };
    case 'hand_start': {
      const blinds = record(message.blinds);
      return {
        ...state,
        heroSeat: chips(message.seat) ?? state.heroSeat,
        dealerSeat: dealerSeat(message, state.dealerSeat),
        complete: false,
        waitingReason: null,
        smallBlind: chips(blinds.small_blind) ?? state.smallBlind,
        bigBlind: chips(blinds.big_blind) ?? state.bigBlind,
      };
    }
    case 'hole_cards':
      return { ...state, holeCards: cards(message.cards) ?? state.holeCards };
    case 'your_turn': {
      const validActions = parseValidActions(message.valid_actions);
      const board = cards(message.community_cards) ?? state.board;
      const currentStreet =
        board.length === 5
          ? 'river'
          : board.length === 4
            ? 'turn'
            : board.length === 3
              ? 'flop'
              : 'preflop';
      const seats =
        currentStreet === state.street
          ? state.seats
          : state.seats.map((seat) => ({ ...seat, bet: 0 }));
      return {
        ...state,
        actorSeat: state.heroSeat,
        dealerSeat: dealerSeat(message, state.dealerSeat),
        validActions,
        turnToken: validActions.length > 0 ? (string(message.turn_token) ?? null) : null,
        pot: chips(message.pot) ?? state.pot,
        board,
        street: currentStreet,
        seats: parseSeats(message.players, seats, false) ?? seats,
      };
    }
    case 'table_state':
      return snapshot(state, message, false);
    case 'player_action':
      return applyAction(state, message);
    case 'community_cards': {
      const incoming = cards(message.cards) ?? [];
      const nextStreet = street(message.street) ?? state.street;
      const count =
        nextStreet === 'flop' ? 3 : nextStreet === 'turn' ? 4 : nextStreet === 'river' ? 5 : 0;
      const board =
        incoming.length === count ? incoming : [...state.board, ...incoming].slice(0, 5);
      return {
        ...state,
        street: nextStreet,
        board,
        validActions: [],
        turnToken: null,
        seats: state.seats.map((s) => ({ ...s, bet: 0 })),
      };
    }
    case 'hand_result': {
      const stacks = record(message.final_stacks);
      return {
        ...state,
        complete: true,
        pot: chips(message.total_pot) ?? chips(message.pot) ?? state.pot,
        turnToken: null,
        validActions: [],
        actorSeat: null,
        seats: state.seats.map((s) => ({
          ...s,
          stack: chips(stacks[String(s.seat)]) ?? s.stack,
          bet: 0,
        })),
      };
    }
    case 'player_joined': {
      const seat = chips(message.seat);
      if (seat === undefined) return state;
      const occupant = state.seats.find((s) => s.seat === seat);
      const name = string(message.name) ?? (message.name === undefined ? occupant?.name : null);
      const newcomer = name != null && name !== occupant?.name;
      const handInProgress =
        !differentTable &&
        state.handId !== null &&
        state.handId === previous.handId &&
        state.street !== 'idle' &&
        !state.complete &&
        ![
          'between_hands_delay',
          'awaiting_hand_start',
          'insufficient_players',
          'table_closing',
        ].includes(state.waitingReason ?? '');
      // A seat acquired after the deal joins the next hand. Resolve this before
      // your_turn so its later in_hand=false snapshot cannot invalidate a decision.
      // Duplicate occupancy notices are partial updates, not a new player/deal.
      const update =
        newcomer && handInProgress && typeof message.in_hand !== 'boolean'
          ? { ...message, in_hand: false }
          : message;
      return {
        ...state,
        seats: parseSeats([update], state.seats, false) ?? state.seats,
      };
    }
    case 'player_left':
      return { ...state, seats: state.seats.filter((s) => s.seat !== message.seat) };
    case 'table_closed':
      return { ...createInitialState(), complete: state.complete };
    default:
      return state;
  }
}
