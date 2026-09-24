import { describe, expect, it } from 'vitest';
import { createInitialState, reduceMessage } from '../src/core/state.js';
import type { PokerState, RawMessage } from '../src/core/types.js';
import { decisionStateKey } from '../src/runtime/authority.js';

const hero = { seat: 0, name: 'hero', stack: 2000, bet: 20, in_hand: true };
const rival = { seat: 1, name: 'rival', stack: 1800, bet: 40, in_hand: true };
const newcomer = { seat: 2, name: 'newcomer', stack: 1500 };
const validActions = [{ action: 'call', amount: 20 }, { action: 'fold' }];

function dealt() {
  const table = reduceMessage(createInitialState(), {
    type: 'table_joined',
    table_id: 'table',
    seat: 0,
    players: [hero, rival],
  });
  return reduceMessage(table, { type: 'hand_start', hand_id: 'hand', table_seq: 1 });
}
function snapshot(state: PokerState, extra: RawMessage = {}) {
  return reduceMessage(state, {
    type: 'table_state',
    table_seq: state.lastTableSeq + 1,
    street: 'preflop',
    actor_seat: 0,
    pot: 60,
    hero: { seat: 0, valid_actions: validActions },
    seats: [hero, rival, { seat: 2, name: null, stack: 0, bet: 0 }],
    ...extra,
  });
}
function turn(state: PokerState, extra: RawMessage = {}) {
  return reduceMessage(state, {
    type: 'your_turn',
    table_seq: state.lastTableSeq + 1,
    turn_token: 'turn',
    pot: 60,
    valid_actions: validActions,
    players: [hero, rival, newcomer],
    ...extra,
  });
}
const arrival = (state: PokerState) => state.seats.find((seat) => seat.seat === 2);

describe('current-hand roster evidence for turn summaries', () => {
  it('recognizes a new occupant before the delayed membership snapshot and join notice', () => {
    const before = snapshot(dealt());
    const requested = turn(before);
    expect(arrival(requested)?.inHand).toBe(false);
    const confirmed = snapshot(requested, {
      seats: [hero, rival, { ...newcomer, in_hand: false }],
    });
    const joined = reduceMessage(confirmed, {
      type: 'player_joined',
      table_seq: confirmed.lastTableSeq + 1,
      ...newcomer,
    });
    expect(decisionStateKey(requested)).toBe(decisionStateKey(confirmed));
    expect(decisionStateKey(joined)).toBe(decisionStateKey(requested));
    expect(joined.seats.slice(0, 2)).toEqual(before.seats.slice(0, 2));
  });

  it.each([true, false])('preserves explicit membership %s on a new occupant', (inHand) => {
    const state = turn(snapshot(dealt()), { players: [{ ...newcomer, in_hand: inHand }] });
    expect(arrival(state)?.inHand).toBe(inHand);
  });

  it.each([true, false, undefined])(
    'retains existing membership %s on sparse summaries',
    (inHand) => {
      const state = snapshot(dealt(), {
        seats: [hero, rival, { ...newcomer, in_hand: inHand, bet: 20 }],
      });
      const next = turn(state, { players: [newcomer] });
      expect(arrival(next)?.inHand).toBe(inHand);
      expect(arrival(next)?.bet).toBe(20);
    },
  );

  it('handles a changed occupant without inheriting the previous player membership or commitments', () => {
    const state = snapshot(dealt(), {
      seats: [hero, rival, { ...newcomer, name: 'old', in_hand: true, bet: 40 }],
    });
    expect(arrival(turn(state))).toMatchObject({ name: 'newcomer', inHand: false, bet: 0 });
  });

  it('does not infer membership on the first turn without a current-hand snapshot', () => {
    expect(arrival(turn(dealt()))?.inHand).toBeUndefined();
    expect(
      arrival(turn(createInitialState(), { table_id: 'table', hand_id: 'hand' }))?.inHand,
    ).toBeUndefined();
  });

  it.each(['hand', 'table'])(
    'does not reuse old roster evidence after a different %s is first reported by your_turn',
    (changed) => {
      const next = turn(
        snapshot(dealt()),
        changed === 'hand' ? { hand_id: 'next' } : { table_id: 'next' },
      );
      expect(next.currentHandRosterKnown).toBe(false);
      expect(arrival(next)?.inHand).toBeUndefined();
    },
  );

  it('clears evidence and inferred waiting membership for the next hand, then accepts official participation', () => {
    const waiting = turn(snapshot(dealt()));
    const next = reduceMessage(waiting, { type: 'hand_start', hand_id: 'next', table_seq: 4 });
    expect(next.currentHandRosterKnown).toBe(false);
    expect(arrival(turn(next))?.inHand).toBeUndefined();
    const confirmed = snapshot(next, { seats: [hero, rival, { ...newcomer, in_hand: true }] });
    expect(arrival(turn(confirmed))?.inHand).toBe(true);
  });

  it.each(['between_hands_delay', 'awaiting_hand_start', 'insufficient_players', 'table_closing'])(
    'does not establish dealt-roster evidence while %s',
    (waitingReason) => {
      const waiting = snapshot(dealt(), { waiting_reason: waitingReason });
      expect(waiting.currentHandRosterKnown).toBe(false);
      expect(arrival(turn(waiting))?.inHand).toBeUndefined();
      const started = reduceMessage(waiting, { type: 'hand_start', hand_id: 'hand', table_seq: 3 });
      expect(arrival(turn(started))?.inHand).toBeUndefined();
    },
  );

  it('requires a supplied nonempty seat roster, not just a table_state envelope', () => {
    for (const seats of [undefined, null, [], [{ seat: -1 }]]) {
      const state = snapshot(dealt(), { seats });
      expect(state.currentHandRosterKnown).toBe(false);
      expect(arrival(turn(state))?.inHand).toBeUndefined();
    }
  });

  it('establishes new evidence from the final authoritative resync snapshot', () => {
    const state = reduceMessage(createInitialState(), {
      type: 'resync_response',
      table_id: 'table',
      hand_id: 'hand',
      to_table_seq: 10,
      role: 'player',
      replayed_events: [],
      snapshot: {
        table_id: 'table',
        hand_id: 'hand',
        street: 'preflop',
        seats: [hero, rival],
        hero: { seat: 0 },
      },
    });
    expect(state.currentHandRosterKnown).toBe(true);
    expect(arrival(turn(state))?.inHand).toBe(false);
  });
});
