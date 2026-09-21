import { describe, expect, it } from 'vitest';
import { createInitialState, OpponentTracker, reduceMessage } from '../src/core/index.js';
import type { PokerState, Street } from '../src/core/types.js';

function beforeAction(street: Street, actorSeat: number | null = 0): PokerState {
  return {
    ...createInitialState(),
    tableId: 'table',
    handId: 'hand',
    heroSeat: 1,
    actorSeat,
    street,
    lastTableSeq: 100,
    seats: [
      { seat: 0, name: 'opponent', stack: 200, bet: 70, status: 'active' },
      { seat: 1, name: 'hero', stack: 1000, bet: 230, status: 'active' },
    ],
  };
}

describe('action-time street provenance', () => {
  it.each([
    ['preflop', 'flop'],
    ['flop', 'turn'],
    ['turn', 'river'],
  ] as const)(
    'keeps the closing %s action on its original street when the event reports %s',
    (from, to) => {
      const message = {
        type: 'player_action',
        table_id: 'table',
        hand_id: 'hand',
        table_seq: 101,
        action_id: 'closing-call',
        seat: 0,
        action: 'call',
        street: to,
        amount: null,
        to_call_before: 160,
        contribution_delta: 160,
        stack_after: 40,
      };
      const untouched = structuredClone(message);
      const state = reduceMessage(beforeAction(from), message);
      expect(state.history[0]).toMatchObject({
        street: from,
        reportedStreet: to,
        streetSource: 'pre_action_state',
        action: 'call',
      });
      expect(message).toEqual(untouched);
      expect(state.seats[0]).toMatchObject({ stack: 40, bet: 230 });
    },
  );

  it('preserves the reported street when an acting-seat snapshot does not prove the prior street', () => {
    for (const actor of [null, 1]) {
      const state = reduceMessage(beforeAction('preflop', actor), {
        type: 'player_action',
        table_seq: 101,
        seat: 0,
        action: 'call',
        street: 'flop',
      });
      expect(state.history[0]).toMatchObject({ street: 'flop', streetSource: 'event' });
    }
  });

  it('counts the closing preflop call as VPIP once, including after replay', () => {
    const tracker = new OpponentTracker();
    let state = reduceMessage(beforeAction('preflop'), {
      type: 'player_action',
      table_seq: 101,
      action_id: 'closing-preflop-call',
      seat: 0,
      action: 'call',
      street: 'flop',
      to_call_before: 160,
    });
    tracker.observe(state);
    state = reduceMessage(state, {
      type: 'community_cards',
      table_seq: 103,
      street: 'flop',
      cards: ['6h', '2h', '4c'],
    });
    tracker.observe(state);
    expect(state.street).toBe('flop');
    expect(state.history[0]?.street).toBe('preflop');
    expect(tracker.snapshot()).toEqual([
      {
        name: 'opponent',
        hands: 1,
        vpip: 1,
        pfr: 0,
        facedBet: 1,
        foldedToBet: 0,
        lastTableSeq: 101,
      },
    ]);
  });
});
