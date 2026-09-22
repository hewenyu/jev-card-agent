import { describe, expect, it } from 'vitest';
import {
  analyzePokerCards,
  estimateUniformEquity,
  evaluateCards,
} from '../src/core/poker-cards.js';

const value = (cards: string) => evaluateCards(cards.split(' '))!;

describe('poker hand evaluator', () => {
  it('orders every category and resolves kickers without suit precedence', () => {
    const ordered = [
      'Ac Jh 9s 5d 2c',
      'Ac Ah 9s 5d 2c',
      'Ac Ah 9s 9d 2c',
      'Ac Ah As 5d 2c',
      '2c 3h 4s 5d 6c',
      'Ac Jc 9c 5c 2c',
      'Ac Ah As 5d 5c',
      'Ac Ah As Ad 2c',
      '2c 3c 4c 5c 6c',
    ].map(value);
    expect(ordered.map((hand) => hand.category)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 1; i < ordered.length; i++)
      expect(ordered[i]!.score).toBeGreaterThan(ordered[i - 1]!.score);
    expect(value('Ac Ah Ks Qd Jc').score).toBeGreaterThan(value('Ac Ah Ks Qd Tc').score);
    expect(value('Ac Ah Ks Qd Jc').score).toBe(value('As Ad Kh Qc Jd').score);
    expect(value('Ac Ah Ks Kd 2c 9s 7h').ranks).toEqual([14, 13, 9]);
  });

  it('handles the wheel, no wraparound, straight flush and the best full house', () => {
    expect(value('Ac 2d 3h 4s 5c 9h Kh')).toMatchObject({ name: 'straight', ranks: [5] });
    expect(value('Ac 2d 3h 4s 5c 6h Kh').ranks).toEqual([6]);
    expect(value('Ac 2d 3h Qs Kc').name).toBe('high_card');
    expect(value('Ac 2c 3c 4c 5c Kc Qc')).toMatchObject({ name: 'straight_flush', ranks: [5] });
    expect(value('Ac Ah As Kc Kh Ks 2d')).toMatchObject({ name: 'full_house', ranks: [14, 13] });
    expect(value('Ac Ah Kc Kh Ks 2d 2c')).toMatchObject({ name: 'full_house', ranks: [13, 14] });
    expect(value('Ac Kc Tc 8c 6c 3c 2c').ranks).toEqual([14, 13, 10, 8, 6]);
    expect(value('2c 2h 2s 2d Ac Kc Qc').ranks).toEqual([2, 14]);
  });

  it('rejects duplicates, malformed cards and wrong card counts', () => {
    expect(evaluateCards(['Ac', 'Ac', '2h', '3s', '4d'])).toBeNull();
    expect(evaluateCards(['AC', 'Kd', '2h', '3s', '4d'])).toBeNull();
    expect(evaluateCards(['Ac', 'Kd'])).toBeNull();
    expect(evaluateCards(['Ac', 'Kd', '2h', '3s', '4d', '5c', '6c', '7c'])).toBeNull();
  });

  it('matches exhaustive five-card selection over diverse seven-card hands', () => {
    const deck = [...'23456789TJQKA'].flatMap((rank) => [...'cdhs'].map((suit) => rank + suit));
    let seed = 41;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let sample = 0; sample < 150; sample++) {
      const remaining = [...deck];
      const cards = Array.from(
        { length: 7 },
        () => remaining.splice(Math.floor(random() * remaining.length), 1)[0]!,
      );
      let best = 0;
      for (let first = 0; first < 7; first++)
        for (let second = first + 1; second < 7; second++)
          best = Math.max(
            best,
            evaluateCards(cards.filter((_, i) => i !== first && i !== second))!.score,
          );
      expect(evaluateCards(cards)!.score).toBe(best);
    }
  });
});

describe('visible poker card facts', () => {
  it('distinguishes a pocket pair plus a public pair from two private value pairs', () => {
    const weak = analyzePokerCards(['7c', '7d'], ['Ac', 'Jh', '9c', '9h', '6c'])!;
    expect(weak.madeHand?.name).toBe('two_pair');
    expect(weak.relativeStrength).toMatchObject({
      pocketPairBelowBoardHigh: true,
      boardPairPlusPocketPair: true,
      twoPairUsingBothHoleRanks: false,
      pairedHoleRanks: [],
      overpair: false,
      topPair: false,
    });
    const privatePairs = analyzePokerCards(['Ac', '7d'], ['Ah', '7c', 'Ks'])!;
    expect(privatePairs.relativeStrength).toMatchObject({
      boardPairPlusPocketPair: false,
      twoPairUsingBothHoleRanks: true,
      pairedHoleRanks: [14, 7],
    });
    const unusedPocket = analyzePokerCards(['2c', '2d'], ['9c', '9h', '7c', '7h', 'Ac'])!;
    expect(unusedPocket.relativeStrength).toMatchObject({
      boardPairPlusPocketPair: false,
      boardTwoPairOnly: true,
    });
    expect(unusedPocket.bestFive?.playsBoard).toBe(true);
  });

  it('labels board-only trips separately from a set, private trips and top pair', () => {
    expect(
      analyzePokerCards(['Ac', 'Kd'], ['9c', '9d', '9h', '7c', '2d'])!.relativeStrength,
    ).toMatchObject({ boardTripsOnly: true, set: false, tripsUsingOneHoleCard: false });
    expect(analyzePokerCards(['9c', '9d'], ['9h', '7c', '2d'])!.relativeStrength).toMatchObject({
      boardTripsOnly: false,
      set: true,
      tripsUsingOneHoleCard: false,
    });
    expect(analyzePokerCards(['9c', 'Ad'], ['9h', '9d', '2c'])!.relativeStrength).toMatchObject({
      boardTripsOnly: false,
      set: false,
      tripsUsingOneHoleCard: true,
    });
    expect(analyzePokerCards(['Ac', 'Kd'], ['Ah', '7c', '2d'])!.relativeStrength).toMatchObject({
      topPair: true,
      overpair: false,
      boardPairOnly: false,
    });
    expect(analyzePokerCards(['Ac', 'Ad'], ['Kh', '7c', '2d'])!.relativeStrength).toMatchObject({
      topPair: false,
      overpair: true,
      pocketPairBelowBoardHigh: false,
    });
    expect(analyzePokerCards(['Ac', 'Kd'], ['7h', '7c', '2d'])!.relativeStrength).toMatchObject({
      topPair: false,
      boardPairOnly: true,
    });
  });

  it('identifies playing the board and hero kicker contribution', () => {
    const royal = analyzePokerCards(['2d', '3d'], ['Ah', 'Kh', 'Qh', 'Jh', 'Th'])!;
    expect(royal.madeHand?.name).toBe('straight_flush');
    expect(royal.bestFive).toEqual({ minimumHoleCards: 0, maximumHoleCards: 0, playsBoard: true });
    const kicker = analyzePokerCards(['Ac', 'Kd'], ['2c', '2d', '2h', '2s', 'Qd'])!;
    expect(kicker.bestFive).toEqual({
      minimumHoleCards: 1,
      maximumHoleCards: 1,
      playsBoard: false,
    });
    const interchangeable = analyzePokerCards(['Ac', '2d'], ['Ah', 'Kc', 'Qd', 'Js', 'Tc'])!;
    expect(interchangeable.bestFive).toEqual({
      minimumHoleCards: 0,
      maximumHoleCards: 1,
      playsBoard: true,
    });
  });

  it('reports hero-specific open-ended, gutshot and flush completion cards', () => {
    const open = analyzePokerCards(['8c', '9d'], ['6h', '7s', 'Kc'])!;
    expect(open.draws.straightCompletionCards).toHaveLength(8);
    expect(
      open.draws.straightCompletionCards.every((card) => card[0] === '5' || card[0] === 'T'),
    ).toBe(true);
    const gutshot = analyzePokerCards(['Ac', '2d'], ['3h', '5s', 'Kc'])!;
    expect(gutshot.draws.straightCompletionCards).toHaveLength(4);
    expect(gutshot.draws.straightCompletionCards.every((card) => card[0] === '4')).toBe(true);
    const flush = analyzePokerCards(['Ah', '2h'], ['Kh', '7h', '3c'])!;
    expect(flush.draws.flushCompletionCards).toHaveLength(9);
    expect(flush.draws.flushCompletionCards).not.toContain('Ah');
    expect(flush.draws.flushCompletionCards).not.toContain('7h');
    expect(flush.board.maximumSameSuit).toBe(2);
  });

  it('does not label board-only completions, made hands or backdoors as draws', () => {
    const straightBoard = analyzePokerCards(['2c', '3d'], ['6h', '7s', '8c', '9d'])!;
    expect(straightBoard.draws.straightCompletionCards).toEqual([]);
    const flushBoard = analyzePokerCards(['2c', '3d'], ['Ah', 'Kh', '8h', '9h'])!;
    expect(flushBoard.draws.flushCompletionCards).toEqual([]);
    const made = analyzePokerCards(['Ah', '2h'], ['Kh', '7h', '3h'])!;
    expect(made.draws.flushCompletionCards).toEqual([]);
    const backdoor = analyzePokerCards(['Ah', '2h'], ['Kh', '7c', '3d'])!;
    expect(backdoor.draws.flushCompletionCards).toEqual([]);
    const river = analyzePokerCards(['Ah', '2h'], ['Kh', '7h', '3c', '4s', '9d'])!;
    expect(river.draws.flushCompletionCards).toEqual([]);
    expect(river.draws.cardsToCome).toBe(0);
  });

  it('keeps preflop and invalid inputs distinct from made hands', () => {
    expect(analyzePokerCards(['Ah', 'Kh'], [])).toMatchObject({
      hole: { pair: false, suited: true },
      madeHand: null,
      bestFive: null,
    });
    expect(analyzePokerCards(['Ah', 'Ah'], [])).toBeNull();
    expect(analyzePokerCards(['Ah', 'Kh'], ['Ah', '7c', '3d'])).toBeNull();
    expect(analyzePokerCards(['Ah', 'Kh'], ['7c'])).toBeNull();
  });
});

describe('uniform random range equity reference', () => {
  it('splits board royal flushes among all players instead of counting ties as wins', () => {
    for (const opponents of [1, 2, 5]) {
      const result = estimateUniformEquity(
        ['2c', '3d'],
        ['Ah', 'Kh', 'Qh', 'Jh', 'Th'],
        opponents,
        { samples: 100 },
      )!;
      expect(result.equity).toBeCloseTo(1 / (opponents + 1), 12);
      expect(result.winProbability).toBe(0);
      expect(result.tieProbability).toBe(1);
      expect(result.standardError).toBeLessThan(1e-8);
    }
  });

  it('excludes known cards, leaving a private royal flush unbeatable', () => {
    const result = estimateUniformEquity(['Ah', 'Kh'], ['Qh', 'Jh', 'Th', '2c', '3d'], 5)!;
    expect(result.equity).toBe(1);
    expect(result.winProbability).toBe(1);
    expect(result.tieProbability).toBe(0);
    const quads = estimateUniformEquity(['Ac', 'Ad'], ['Ah', 'As', '2c', '7d', '9h'], 5)!;
    expect(quads.equity).toBe(1);
  });

  it('is reproducible, sensible preflop and explicitly not action EV', () => {
    const first = estimateUniformEquity(['Ac', 'Ad'], [], 1)!;
    expect(estimateUniformEquity(['Ac', 'Ad'], [], 1)).toEqual(first);
    expect(first.equity).toBeGreaterThan(0.78);
    expect(first.equity).toBeLessThan(0.92);
    expect(estimateUniformEquity(['Ac', 'Ad'], [], 5)!.equity).toBeLessThan(first.equity);
    expect(first.rangeAssumption).toBe('uniform_random_legal_hole_cards');
    expect(first.caveat).toContain('Not action EV');
    expect(first.standardError).toBeGreaterThan(0);
    expect(estimateUniformEquity(['Ac', 'Ad'], [], 1, { samples: 1 })!.standardError).toBeNull();
  });

  it('rejects duplicate information, impossible boards and unbounded work', () => {
    expect(estimateUniformEquity(['Ac', 'Ad'], ['Ac', '2c', '3d'], 1)).toBeNull();
    expect(estimateUniformEquity(['Ac', 'Ad'], ['2c', '3d'], 1)).toBeNull();
    for (const opponents of [0, 6, 1.5])
      expect(estimateUniformEquity(['Ac', 'Ad'], [], opponents)).toBeNull();
    for (const samples of [0, 10001, Infinity, 1.5])
      expect(estimateUniformEquity(['Ac', 'Ad'], [], 1, { samples })).toBeNull();
    expect(estimateUniformEquity(['Ac', 'Ad'], [], 1, { seed: NaN })).toBeNull();
  });
});
