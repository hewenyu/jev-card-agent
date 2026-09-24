import { buildCandidates } from '../../core/candidates.js';
import type { Candidate, HistoryEntry, PokerState, Street, ValidAction } from '../../core/types.js';
import { POKER_DECK } from './random.js';
import { settlePots, type PokerSettlement } from './settlement.js';

export const POKER_SIMULATOR_VERSION = 'six-max-nlhe-independent-v1';
export interface PokerHandOptions {
  deck: string[];
  dealer: number;
  stacks: number[];
  smallBlind: number;
  bigBlind: number;
  handId: string;
}
interface Player {
  stack: number;
  bet: number;
  committed: number;
  folded: boolean;
  cards: string[];
  lastActedBet: number | null;
}

/** Private state is never handed to a policy; view() is the only observation boundary. */
export class PokerHand {
  readonly #players: Player[];
  readonly #options: PokerHandOptions;
  readonly #boardRunout: string[];
  readonly #history: HistoryEntry[] = [];
  readonly #pending = new Set<number>();
  #streetIndex = 0;
  #currentBet: number;
  #lastFullRaise: number;
  #actor: number | null;
  #settlement: PokerSettlement | null = null;

  constructor(options: PokerHandOptions) {
    if (
      options.stacks.length !== 6 ||
      options.stacks.some((s) => !Number.isSafeInteger(s) || s <= 0) ||
      !Number.isSafeInteger(options.stacks.reduce((a, b) => a + b, 0)) ||
      !Number.isSafeInteger(options.dealer) ||
      options.dealer < 0 ||
      options.dealer >= 6 ||
      !Number.isSafeInteger(options.smallBlind) ||
      !Number.isSafeInteger(options.bigBlind) ||
      options.smallBlind <= 0 ||
      options.bigBlind < options.smallBlind ||
      options.deck.length !== 52 ||
      new Set(options.deck).size !== 52 ||
      options.deck.some((c) => !POKER_DECK.includes(c))
    )
      throw new Error('Invalid six-max hand setup');
    this.#options = structuredClone(options);
    this.#players = options.stacks.map((stack) => ({
      stack,
      bet: 0,
      committed: 0,
      folded: false,
      cards: [],
      lastActedBet: null,
    }));
    for (let round = 0; round < 2; round++)
      for (let offset = 1; offset <= 6; offset++) {
        this.#players[(options.dealer + offset) % 6]!.cards.push(
          options.deck[round * 6 + offset - 1]!,
        );
      }
    // Burn before flop, turn and river. Board positions never depend on action count.
    this.#boardRunout = [13, 14, 15, 17, 19].map((index) => options.deck[index]!);
    this.#currentBet = options.bigBlind;
    this.#lastFullRaise = options.bigBlind;
    this.#pay((options.dealer + 1) % 6, options.smallBlind);
    this.#pay((options.dealer + 2) % 6, options.bigBlind);
    this.#players.forEach((p, seat) => {
      if (p.stack > 0) this.#pending.add(seat);
    });
    this.#actor = null;
    this.#advance((options.dealer + 2) % 6);
    this.#assertConservation();
  }
  get actor(): number | null {
    return this.#actor;
  }
  get complete(): boolean {
    return this.#settlement !== null;
  }
  get settlement(): PokerSettlement | null {
    return structuredClone(this.#settlement);
  }
  get finalStacks(): number[] {
    if (!this.complete) throw new Error('Hand has not settled');
    return this.#players.map((p) => p.stack);
  }
  get street(): Street {
    return (['preflop', 'flop', 'turn', 'river'] as const)[this.#streetIndex]!;
  }
  #pay(seat: number, chips: number): void {
    const player = this.#players[seat]!;
    const paid = Math.min(player.stack, chips);
    player.stack -= paid;
    player.bet += paid;
    player.committed += paid;
  }
  #canRaise(seat: number): boolean {
    const player = this.#players[seat]!;
    if (
      !this.#players.some((p, i) => i !== seat && !p.folded && p.stack + p.bet > this.#currentBet)
    )
      return false;
    return (
      player.lastActedBet === null ||
      player.lastActedBet === 0 ||
      this.#currentBet - player.lastActedBet >= this.#lastFullRaise
    );
  }
  #legal(seat: number): ValidAction[] {
    if (this.complete || seat !== this.#actor) return [];
    const player = this.#players[seat]!;
    const call = Math.max(0, this.#currentBet - player.bet);
    const actions: ValidAction[] =
      call > 0
        ? [{ action: 'fold' }, { action: 'call', amount: Math.min(call, player.stack) }]
        : [{ action: 'check' }];
    const max = player.bet + player.stack;
    if (max <= this.#currentBet) actions.push({ action: 'all_in' });
    else if (this.#canRaise(seat)) {
      const min = this.#currentBet + this.#lastFullRaise;
      if (max >= min) actions.push({ action: 'raise', min, max });
      actions.push({ action: 'all_in' });
    }
    return actions;
  }
  view(seat: number): PokerState {
    if (!Number.isSafeInteger(seat) || seat < 0 || seat > 5) throw new Error('Invalid actor seat');
    const boardCount = [0, 3, 4, 5][this.#streetIndex]!;
    return {
      tableId: 'evaluation-six-max',
      handId: this.#options.handId,
      heroSeat: seat,
      dealerSeat: this.#options.dealer,
      actorSeat: this.#actor,
      street: this.street,
      pot: this.complete ? 0 : this.#players.reduce((sum, p) => sum + p.committed, 0),
      board: this.#boardRunout.slice(0, boardCount),
      holeCards: [...this.#players[seat]!.cards],
      seats: this.#players.map((p, index) => ({
        seat: index,
        name: `player-${index}`,
        stack: p.stack,
        bet: p.bet,
        status: p.folded ? 'folded' : p.stack === 0 ? 'all_in' : 'active',
        inHand: true,
        folded: p.folded,
      })),
      smallBlind: this.#options.smallBlind,
      bigBlind: this.#options.bigBlind,
      validActions: this.#legal(seat),
      turnToken: seat === this.#actor ? `${this.#options.handId}:${this.#history.length}` : null,
      lastTableSeq: this.#history.length,
      history: structuredClone(this.#history),
      handStartStacks: Object.fromEntries(
        this.#options.stacks.map((stack, index) => [String(index), stack]),
      ),
      complete: this.complete,
      historyIncomplete: false,
      waitingReason: null,
      currentHandRosterKnown: true,
    };
  }
  candidates(): Candidate[] {
    return this.#actor === null ? [] : buildCandidates(this.view(this.#actor));
  }
  act(action: Pick<Candidate, 'action' | 'amount'>): void {
    const seat = this.#actor;
    if (seat === null || this.complete) throw new Error('No pending actor');
    const player = this.#players[seat]!;
    const legal = this.#legal(seat).some(
      (a) =>
        a.action === action.action &&
        (action.action === 'raise'
          ? Number.isSafeInteger(action.amount) &&
            action.amount! >= a.min! &&
            action.amount! <= a.max!
          : action.amount === undefined),
    );
    if (!legal) throw new Error('Illegal poker action');
    const previousBet = this.#currentBet;
    const call = Math.max(0, previousBet - player.bet);
    const oldStack = player.stack;
    this.#pending.delete(seat);
    if (action.action === 'fold') player.folded = true;
    else if (action.action === 'call') this.#pay(seat, call);
    else if (action.action === 'raise') this.#pay(seat, action.amount! - player.bet);
    else if (action.action === 'all_in') this.#pay(seat, player.stack);
    if (player.bet > previousBet) {
      this.#currentBet = player.bet;
      const increment = player.bet - previousBet;
      if (increment >= this.#lastFullRaise) this.#lastFullRaise = increment;
      this.#players.forEach((p, i) => {
        if (i !== seat && !p.folded && p.stack > 0 && p.bet < this.#currentBet)
          this.#pending.add(i);
      });
    }
    player.lastActedBet = this.#currentBet;
    this.#history.push({
      handId: this.#options.handId,
      tableSeq: this.#history.length + 1,
      seat,
      name: `player-${seat}`,
      action: action.action,
      street: this.street,
      amount: action.action === 'raise' ? action.amount! : oldStack - player.stack,
      toCallBefore: call,
      streetSource: 'pre_action_state',
      actionId: null,
      timestamp: null,
    });
    this.#advance(seat);
    this.#assertConservation();
  }
  #advance(after: number): void {
    const live = this.#players.filter((p) => !p.folded);
    if (live.length === 1) {
      this.#finish();
      return;
    }
    for (const seat of this.#pending) {
      const p = this.#players[seat]!;
      if (p.folded || p.stack === 0) this.#pending.delete(seat);
    }
    const solvent = this.#players
      .map((p, seat) => ({ p, seat }))
      .filter(({ p }) => !p.folded && p.stack > 0);
    if (solvent.length <= 1 && (!solvent.length || solvent[0]!.p.bet >= this.#currentBet)) {
      this.#streetIndex = 3;
      this.#finish();
      return;
    }
    if (!this.#pending.size) {
      if (this.#streetIndex === 3) {
        this.#finish();
        return;
      }
      this.#streetIndex++;
      this.#currentBet = 0;
      this.#lastFullRaise = this.#options.bigBlind;
      this.#players.forEach((p, seat) => {
        p.bet = 0;
        p.lastActedBet = null;
        if (!p.folded && p.stack > 0) this.#pending.add(seat);
      });
      after = this.#options.dealer;
    }
    for (let offset = 1; offset <= 6; offset++) {
      const seat = (after + offset) % 6;
      if (this.#pending.has(seat)) {
        this.#actor = seat;
        return;
      }
    }
    throw new Error('Betting round has no legal continuation');
  }
  #finish(): void {
    this.#settlement = settlePots(
      this.#players.map((p, seat) => ({
        seat,
        committed: p.committed,
        folded: p.folded,
        cards: p.cards,
      })),
      this.#boardRunout.slice(0, [0, 3, 4, 5][this.#streetIndex]!),
      this.#options.dealer,
    );
    this.#players.forEach((p, seat) => {
      p.stack += this.#settlement!.payouts[seat]!;
      p.bet = 0;
    });
    this.#actor = null;
    this.#pending.clear();
  }
  #assertConservation(): void {
    const total = this.#players.reduce(
      (sum, p) => sum + p.stack + (this.complete ? 0 : p.committed),
      0,
    );
    if (
      total !== this.#options.stacks.reduce((a, b) => a + b, 0) ||
      this.#players.some((p) => !Number.isSafeInteger(p.stack) || p.stack < 0)
    )
      throw new Error('Poker hand violated chip conservation');
  }
}
