import { describe, expect, it } from 'vitest';
import { buildContext, buildCandidates, createInitialState } from '../src/core/index.js';
import { bettingFacts, callAmount, positionFacts } from '../src/core/poker-math.js';
import { candidateCriteria, projectJevState } from '../src/core/harness.js';
import type { PokerState } from '../src/core/types.js';

function situation(): PokerState {
  return {
    ...createInitialState(),
    tableId: 'table',
    handId: 'hand',
    heroSeat: 2,
    dealerSeat: 0,
    turnToken: 'private-authority',
    street: 'river',
    pot: 5794,
    holeCards: ['7s', 'Ac'],
    board: ['Kc', 'Qd', '8s', '4c', '2d'],
    seats: [
      { seat: 0, name: 'opponent', stack: 0, bet: 4316, status: 'active', folded: false },
      { seat: 2, name: 'hero', stack: 2231, bet: 0, status: 'active', folded: false },
    ],
    validActions: [{ action: 'fold' }, { action: 'call', amount: 2231 }],
  };
}

describe('poker harness evidence and prices', () => {
  it('excludes unreachable excess wagers and preserves coverage from an all-in player', () => {
    const context = buildContext(situation());
    expect(context.harness?.cards?.madeHand?.name).toBe('high_card');
    expect(context.potOdds).toBeCloseTo(2231 / (3709 + 2231), 4);
    expect(context.effectiveStack).toBe(2231);
    expect(context.harness?.betting).toMatchObject({
      inaccessibleCurrentWagersChips: 2085,
      contestablePotBeforeCallChips: 3709,
      callConsumesStack: true,
      sidePotsPossible: false,
    });
  });
  it('recognizes a priced short all-in without an explicit call option', () => {
    const state = situation();
    state.seats[1]!.stack = 80;
    state.seats[1]!.bet = 20;
    state.seats[0]!.bet = 300;
    state.validActions = [{ action: 'fold' }, { action: 'all_in', amount: 80 }];
    expect(callAmount(state)).toBe(80);
    const context = buildContext(state);
    expect(candidateCriteria(context, buildCandidates(state)).all_in).toMatchObject({
      additionalChips: 80,
      meaning: 'All-in call',
    });
    state.validActions = [{ action: 'check' }, { action: 'all_in', amount: 80 }];
    expect(callAmount(state)).toBe(0);
  });
  it('marks unequal multiway all-in prices as a bound instead of fabricating single-pot EV', () => {
    const state = situation();
    state.seats.push({ seat: 3, name: 'third', stack: 0, bet: 1000, status: 'active' });
    const facts = bettingFacts(buildContext(state));
    expect(facts.sidePotsPossible).toBe(true);
    expect(facts.priceQualification).toContain('separate equities');
    state.seats[1]!.stack = 5000;
    expect(bettingFacts(buildContext(state)).sidePotsPossible).toBe(true);
  });

  it('bounds historical examples without erasing the stored evidence or current decision facts', () => {
    const context = buildContext(situation());
    const line = Array.from({ length: 32 }, () => ({
      seat: 0,
      name: 'opponent',
      street: 'river' as const,
      action: 'raise' as const,
      amount: 999999999999,
      contribution: 999999999999,
      potBefore: 999999999999,
      toCallBefore: 999999999999,
      tableSeq: 1,
    }));
    const street = {
      observedActions: 1,
      raises: 1,
      calls: 0,
      checks: 0,
      folds: 0,
      allIns: 0,
      facedBetObserved: 1,
      foldedToObservedBet: 0,
      sizedContributions: 1,
      contributionToPotSum: 1,
    };
    context.seats = Array.from({ length: 6 }, (_, seat) => ({
      seat,
      name: seat === 2 ? 'hero' : `opponent${seat}`,
      stack: 1000,
      bet: 0,
      status: 'active',
    }));
    context.opponentMemory = context.seats
      .filter((seat) => seat.seat !== 2)
      .map((seat) => ({
        version: 'completed-opponent-encounters-v1',
        name: seat.name!,
        asOf: '2026-01-02',
        sampledHands: 200,
        sampleLimit: 200,
        sampleCapped: true,
        firstCompletedAt: '2026-01-01',
        lastCompletedAt: '2026-01-01',
        shownHands: 3,
        streets: { preflop: street, flop: street, turn: street, river: street },
        showdowns: Array.from({ length: 3 }, (_, index) => ({
          handId: `past-${seat.seat}-${index}`,
          tableId: 'past',
          completedAt: '2026-01-01',
          receivedAt: '2026-01-01',
          tableSeq: 1,
          resultEventId: index,
          board: ['Ac', 'Kd', '9h', '8s', '2c'],
          shownCards: ['Qh', 'Jh'],
          heroParticipated: true,
          omittedActions: 12,
          line,
        })),
        recentEncountersWithHero: [],
        caveats: [],
      }));
    const before = JSON.stringify(context.opponentMemory);
    const projected = projectJevState(context);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(34000);
    expect(JSON.stringify(projected)).toContain('"omittedActions":12');
    const memories = projected.opponentMemory as { examplesOmittedForInputSize: number }[];
    expect(
      memories.reduce((sum, memory) => sum + memory.examplesOmittedForInputSize, 0),
    ).toBeGreaterThan(0);
    expect(JSON.stringify(context.opponentMemory)).toBe(before);
    expect(projected.holeCards).toEqual(context.holeCards);
  });
  it('derives clockwise positions through empty seats and handles heads-up button small blind', () => {
    expect(positionFacts(buildContext(situation())).hero).toBe('BB');
    const state = situation();
    state.seats = Array.from({ length: 6 }, (_, seat) => ({
      seat,
      name: `player${seat}`,
      stack: 1000,
      bet: 0,
      status: 'active',
    }));
    state.dealerSeat = 5;
    state.heroSeat = 2;
    expect(positionFacts(buildContext(state)).hero).toBe('UTG');
    state.dealerSeat = null;
    expect(positionFacts(buildContext(state)).hero).toBeNull();
  });
  it('adds conventional opening sizes and intermediate short-stack postflop sizes', () => {
    const state = situation();
    state.street = 'preflop';
    state.board = [];
    state.pot = 30;
    state.seats[0]!.bet = 20;
    state.seats[0]!.stack = 1980;
    state.validActions = [
      { action: 'fold' },
      { action: 'call', amount: 20 },
      { action: 'raise', min: 40, max: 2231 },
      { action: 'all_in' },
    ];
    expect(buildCandidates(state).map((c) => c.amount)).toEqual(
      expect.arrayContaining([44, 50, 60]),
    );
    state.street = 'river';
    state.pot = 1986;
    state.seats[1]!.stack = 440;
    state.validActions = [
      { action: 'check' },
      { action: 'raise', min: 20, max: 440 },
      { action: 'all_in' },
    ];
    expect(buildCandidates(state).map((c) => c.amount)).toContain(220);
  });
  it('keeps raw history auditable while excluding unrelated outcome streaks and authority from requests', () => {
    const context = buildContext(situation());
    context.handId = 'audit-hand-uuid';
    context.tableId = 'audit-table-uuid';
    const request = projectJevState(context);
    expect(request).toHaveProperty('harness.cards.madeHand.name', 'high_card');
    expect(request).not.toHaveProperty('recentOutcomes');
    expect(request).not.toHaveProperty('harness.uniformShowdownReference');
    expect(context.harness?.uniformShowdownReference).not.toBeNull();
    expect(JSON.stringify(request)).not.toContain('audit-hand-uuid');
    expect(JSON.stringify(request)).not.toContain('private-authority');
    expect(context).toHaveProperty('recentOutcomes');
  });
  it('explains the dominated free fold without secretly choosing an action', () => {
    const state = situation();
    state.validActions = [{ action: 'fold' }, { action: 'check' }];
    const candidates = buildCandidates(state);
    const criteria = candidateCriteria(buildContext(state), candidates);
    expect(candidates.map((c) => c.id)).toEqual(['fold', 'check']);
    expect(criteria.fold).toHaveProperty('warning');
    expect(criteria.check).toHaveProperty('additionalChips', 0);
  });
});
