import { describe, expect, it } from 'vitest';
import { PokerHand } from '../src/evaluation/poker/engine.js';
import { settlePots, type PotPlayer } from '../src/evaluation/poker/settlement.js';
import { POKER_DECK, pokerRandom, shuffleDeck } from '../src/evaluation/poker/random.js';
import { opponentAction, OPPONENT_SUITES } from '../src/evaluation/poker/opponents.js';

function hand(stacks = [1000, 1000, 1000, 1000, 1000, 1000], dealer = 0) {
  return new PokerHand({
    deck: shuffleDeck(1, 0),
    stacks,
    dealer,
    smallBlind: 5,
    bigBlind: 10,
    handId: 'test-hand',
  });
}
function passToFlop(game: PokerHand) {
  while (game.street === 'preflop' && !game.complete) {
    game.act(game.candidates().find((c) => c.action === 'check' || c.action === 'call')!);
  }
}
function pots(entries: Partial<PotPlayer>[]): PotPlayer[] {
  return Array.from({ length: 6 }, (_, seat) => ({
    seat,
    committed: 0,
    folded: true,
    cards: [],
    ...entries[seat],
  }));
}

describe('six-max engine rules', () => {
  it('rotates blinds, starts UTG, preserves BB option and starts postflop left of button', () => {
    for (let dealer = 0; dealer < 6; dealer++) {
      const game = hand(undefined, dealer);
      expect(game.actor).toBe((dealer + 3) % 6);
      const view = game.view(game.actor!);
      expect(view.pot).toBe(15);
      expect(view.seats[(dealer + 1) % 6]!.bet).toBe(5);
      expect(view.seats[(dealer + 2) % 6]!.bet).toBe(10);
      for (let i = 0; i < 5; i++) game.act({ action: 'call' });
      expect(game.actor).toBe((dealer + 2) % 6);
      expect(game.candidates().map((c) => c.action)).toContain('check');
      game.act({ action: 'check' });
      expect(game.street).toBe('flop');
      expect(game.actor).toBe((dealer + 1) % 6);
      expect(game.view(game.actor!).pot).toBe(60);
      expect(game.view(game.actor!).seats.every((p) => p.bet === 0)).toBe(true);
    }
  });
  it('enforces raise-to minimum and returns the uncalled blind after everyone folds', () => {
    const game = hand();
    expect(() => game.act({ action: 'raise', amount: 19 })).toThrow('Illegal');
    expect(() => game.act({ action: 'raise', amount: 20.5 })).toThrow('Illegal');
    for (let i = 0; i < 5; i++) game.act({ action: 'fold' });
    expect(game.complete).toBe(true);
    expect(game.finalStacks).toEqual([1000, 995, 1005, 1000, 1000, 1000]);
    expect(game.settlement!.pots).toEqual([
      { amount: 10, eligible: [2], winners: [2], kind: 'contested' },
      { amount: 5, eligible: [2], winners: [2], kind: 'uncalled' },
    ]);
    expect(() => game.act({ action: 'check' })).toThrow('No pending actor');
  });
  it('a short all-in raises the price without reopening an earlier full raise', () => {
    const game = hand([1000, 1000, 1000, 1000, 1000, 150]);
    game.act({ action: 'raise', amount: 100 });
    game.act({ action: 'call' });
    game.act({ action: 'all_in' });
    for (let i = 0; i < 3; i++) game.act({ action: 'fold' });
    expect(game.actor).toBe(3);
    expect(game.view(3).validActions.map((a) => a.action)).toEqual(['fold', 'call']);
    expect(() => game.act({ action: 'raise', amount: 240 })).toThrow('Illegal');
  });
  it('cumulative short all-ins reopen when the player faces a full-raise increment', () => {
    const game = hand([190, 1000, 1000, 1000, 1000, 150]);
    game.act({ action: 'raise', amount: 100 });
    game.act({ action: 'call' });
    game.act({ action: 'all_in' });
    game.act({ action: 'all_in' });
    game.act({ action: 'fold' });
    game.act({ action: 'fold' });
    expect(game.actor).toBe(3);
    expect(game.view(3).validActions.find((a) => a.action === 'raise')).toEqual({
      action: 'raise',
      min: 280,
      max: 1000,
    });
  });
  it('a short opening all-in needs a full minimum increment, not a limit-poker completion', () => {
    const game = hand([1000, 1000, 15, 1000, 1000, 1000]);
    passToFlop(game);
    game.act({ action: 'check' });
    game.act({ action: 'all_in' });
    expect(game.actor).toBe(3);
    expect(game.view(3).validActions.find((a) => a.action === 'raise')!.min).toBe(15);
    expect(() => game.act({ action: 'raise', amount: 10 })).toThrow('Illegal');
    game.act({ action: 'raise', amount: 15 });
    expect(game.view(4).validActions.find((a) => a.action === 'raise')!.min).toBe(25);
  });
  it('does not offer a side-pot raise when the only opponents are all-in', () => {
    const game = hand([10, 10, 10, 1000, 10, 10]);
    game.act({ action: 'call' });
    for (let i = 0; i < 4 && !game.complete; i++) game.act({ action: 'all_in' });
    expect(game.complete).toBe(true);
    expect(game.finalStacks.reduce((a, b) => a + b, 0)).toBe(1050);
  });
  it('validates deck and chips before play', () => {
    expect(
      () =>
        new PokerHand({
          deck: Array(52).fill('As'),
          stacks: [1, 1, 1, 1, 1, 1],
          dealer: 0,
          smallBlind: 1,
          bigBlind: 2,
          handId: 'bad',
        }),
    ).toThrow('Invalid');
    expect(() => hand([0, 10, 10, 10, 10, 10])).toThrow('Invalid');
  });
});

describe('settlement', () => {
  it('awards the main pot and each side pot by eligibility, and refunds unmatched chips', () => {
    const result = settlePots(
      pots([
        { committed: 50, folded: false, cards: ['As', 'Ah'] },
        { committed: 100, folded: false, cards: ['Ks', 'Kh'] },
        { committed: 200, folded: false, cards: ['Qs', 'Qh'] },
      ]),
      ['2c', '3d', '7h', '8s', '9c'],
      5,
    );
    expect(result.payouts).toEqual([150, 100, 100, 0, 0, 0]);
    expect(result.pots.map((p) => [p.amount, p.eligible, p.kind])).toEqual([
      [150, [0, 1, 2], 'contested'],
      [100, [1, 2], 'contested'],
      [100, [2], 'uncalled'],
    ]);
  });
  it('folded contributions remain in the pot and suits do not break ties; odd chip goes left of button', () => {
    const result = settlePots(
      pots([
        { committed: 5, folded: false, cards: ['2c', '3c'] },
        { committed: 5, folded: false, cards: ['4d', '5d'] },
        { committed: 5, folded: true, cards: ['6h', '7h'] },
      ]),
      ['As', 'Ks', 'Qs', 'Js', 'Ts'],
      0,
    );
    expect(result.payouts).toEqual([7, 8, 0, 0, 0, 0]);
  });
  it('split side pots also conserve every integer chip', () => {
    const result = settlePots(
      pots([
        { committed: 2, folded: false, cards: ['2c', '3c'] },
        { committed: 5, folded: false, cards: ['4d', '5d'] },
        { committed: 5, folded: false, cards: ['6h', '7h'] },
        { committed: 5, folded: true, cards: ['8h', '9h'] },
      ]),
      ['As', 'Ks', 'Qs', 'Js', 'Ts'],
      0,
    );
    expect(result.payouts).toEqual([2, 8, 7, 0, 0, 0]);
    expect(result.payouts.reduce((a, b) => a + b, 0)).toBe(17);
  });
});

describe('visibility, randomness and continuing real branches', () => {
  it('exposes exactly two private cards and revealed board, never the future runout/deck', () => {
    const game = hand();
    const before = game.view(3);
    expect(before.board).toEqual([]);
    expect(before.holeCards).toHaveLength(2);
    expect(before.seats.every((seat) => !('cards' in seat))).toBe(true);
    before.holeCards[0] = 'XX';
    before.seats[3]!.stack = 1;
    expect(game.view(3).holeCards).not.toContain('XX');
    expect(game.view(3).seats[3]!.stack).toBe(1000);
    passToFlop(game);
    expect(game.view(game.actor!).board).toHaveLength(3);
    expect(Object.keys(game)).toEqual([]);
  });
  it('keeps deck and other actor streams stable after a divergent branch consumes random samples', () => {
    const deck = shuffleDeck(101, 9);
    const actorA = pokerRandom(101, 9, 'opponent', 1);
    const actorB = pokerRandom(101, 9, 'opponent', 2);
    const expected = pokerRandom(101, 9, 'opponent', 2);
    for (let i = 0; i < 100; i++) actorA();
    expect(actorB()).toBe(expected());
    expect(shuffleDeck(101, 9)).toEqual(deck);
    expect(new Set(deck).size).toBe(52);
    expect(deck.sort()).toEqual([...POKER_DECK].sort());
  });
  it('different actions produce different future price, legal actions and payoffs', () => {
    const a = hand();
    const b = hand();
    a.act({ action: 'fold' });
    b.act({ action: 'raise', amount: 100 });
    expect(a.view(4).validActions.find((x) => x.action === 'call')!.amount).toBe(10);
    expect(b.view(4).validActions.find((x) => x.action === 'call')!.amount).toBe(100);
    while (!a.complete)
      a.act(a.candidates().find((c) => c.action === 'check' || c.action === 'fold')!);
    while (!b.complete)
      b.act(b.candidates().find((c) => c.action === 'check' || c.action === 'fold')!);
    expect(a.finalStacks[3]).toBe(1000);
    expect(b.finalStacks[3]).toBe(1015);
  });
  it('conserves chips over 600 seeded hands with different stacks, buttons and styles', () => {
    for (let seed = 0; seed < 600; seed++) {
      const random = pokerRandom(seed, 'test-choices');
      const stacks = Array.from({ length: 6 }, () => 1 + Math.floor(random() * 300));
      const game = new PokerHand({
        deck: shuffleDeck(seed, 0),
        stacks,
        dealer: seed % 6,
        smallBlind: 5,
        bigBlind: 10,
        handId: String(seed),
      });
      let steps = 0;
      while (!game.complete) {
        const candidates = game.candidates();
        const state = game.view(game.actor!);
        const action =
          seed % 2
            ? opponentAction(
                OPPONENT_SUITES['mixed-v1']![game.actor! % 5]!,
                state,
                candidates,
                random,
              )
            : candidates[Math.floor(random() * candidates.length)]!;
        game.act(action);
        expect(++steps).toBeLessThan(1000);
      }
      expect(game.finalStacks.reduce((a, b) => a + b, 0)).toBe(stacks.reduce((a, b) => a + b, 0));
      expect(game.finalStacks.every((stack) => Number.isSafeInteger(stack) && stack >= 0)).toBe(
        true,
      );
    }
  });
});
