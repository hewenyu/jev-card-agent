import { describe, expect, it } from 'vitest';
import { createInitialState, reduceMessage } from '../src/core/index.js';

function table() {
  return reduceMessage(createInitialState(), {
    type: 'table_state',
    table_id: 'table',
    hand_id: 'hand',
    table_seq: 10,
    seats: Array.from({ length: 6 }, (_, seat) => ({
      seat,
      name: `Player ${seat}`,
      stack: 1000 + seat * 100,
      bet: 10 * seat,
      in_hand: true,
      folded: seat === 1,
    })),
    hero: { seat: 0 },
  });
}

describe('all players use authoritative server chip values', () => {
  it('merges sparse turn summaries without removing absent players or resetting their commitments', () => {
    const before = table();
    const state = reduceMessage(before, {
      type: 'your_turn',
      table_id: 'table',
      hand_id: 'hand',
      table_seq: 11,
      players: [
        { seat: 0, name: 'Player 0', stack: 875 },
        { seat: 4, stack: 1111 },
      ],
      valid_actions: [{ action: 'check' }],
      turn_token: 'local-test',
    });
    expect(state.seats).toHaveLength(6);
    expect(state.seats[0]?.stack).toBe(875);
    expect(state.seats[4]).toMatchObject({ name: 'Player 4', stack: 1111, bet: 40 });
    expect(state.seats[1]).toEqual(before.seats[1]);
    expect(state.seats[5]).toEqual(before.seats[5]);
    expect(reduceMessage(state, { type: 'your_turn', table_seq: 12, players: [] }).seats).toEqual(
      state.seats,
    );
  });

  it('applies opponent stack_after and final_stacks, ignoring old events and payout animation arithmetic', () => {
    let state = reduceMessage(table(), {
      type: 'player_action',
      table_seq: 11,
      seat: 3,
      action: 'raise',
      stack_after: 907,
      contribution_delta: 999,
      amount: 999,
      pot_after: 1400,
    });
    expect(state.seats[3]?.stack).toBe(907);
    const finalStacks = { 0: 800, 1: 0, 2: 1400, 3: 2307, 4: 1200, 5: 1793 };
    state = reduceMessage(state, {
      type: 'hand_result',
      table_seq: 12,
      final_stacks: finalStacks,
      payouts: [{ seat: 3, amount: 9999 }],
    });
    expect(state.seats.map((seat) => seat.stack)).toEqual(Object.values(finalStacks));
    expect(state.seats.every((seat) => seat.bet === 0)).toBe(true);
    expect(state.complete).toBe(true);
    expect(state.pot).toBe(1400);
    expect(reduceMessage(state, { type: 'table_state', table_seq: 11, seats: table().seats })).toBe(
      state,
    );
    const oldSnapshot = {
      type: 'resync_response',
      to_table_seq: 10,
      snapshot: { seats: table().seats },
    };
    expect(reduceMessage(state, oldSnapshot)).toBe(state);
  });

  it('clears previous-street bets before merging a new-street turn summary', () => {
    const before = table();
    const state = reduceMessage(before, {
      type: 'your_turn',
      table_seq: 11,
      community_cards: ['Ah', 'Kd', '2c'],
      players: [
        { seat: 0, stack: 975 },
        { seat: 4, stack: 1350, bet: 50 },
      ],
    });
    expect(state.street).toBe('flop');
    expect(state.seats.map((seat) => seat.bet)).toEqual([0, 0, 0, 0, 50, 0]);
    expect(state.seats[0]?.stack).toBe(975);
    const sameStreet = reduceMessage(state, {
      type: 'your_turn',
      table_seq: 12,
      community_cards: ['Ah', 'Kd', '2c'],
      players: [{ seat: 4, stack: 1350 }],
    });
    expect(sameStreet.seats[4]?.bet).toBe(50);
    expect(before.seats[4]?.bet).toBe(40);
  });

  it.each([
    [{ total_pot: 500, pot: 450 }, 500],
    [{ pot: 450 }, 450],
    [{ total_pot: 0, pot: 450 }, 0],
  ])('keeps the server settlement pot separate from cleared bets: %j', (fields, expected) => {
    const state = reduceMessage(table(), { type: 'hand_result', table_seq: 11, ...fields });
    expect(state.pot).toBe(expected);
    expect(state.complete).toBe(true);
    expect(state.seats.every((seat) => seat.bet === 0)).toBe(true);
  });

  it('replaces occupancy only on full snapshots and explicit departures, and accepts a new occupant’s server stack', () => {
    const state = reduceMessage(table(), { type: 'player_left', table_seq: 11, seat: 5 });
    expect(state.seats.find((seat) => seat.seat === 5)).toBeUndefined();
    const joined = reduceMessage(state, {
      type: 'player_joined',
      table_seq: 12,
      seat: 5,
      name: 'Replacement',
      stack: 1500,
    });
    expect(joined.seats.find((seat) => seat.seat === 5)).toMatchObject({
      name: 'Replacement',
      stack: 1500,
      bet: 0,
    });
    const seats = joined.seats.map((seat) =>
      seat.seat === 2 ? { seat: 2, name: null, stack: 0, bet: 0, status: 'empty' } : seat,
    );
    const snapshot = reduceMessage(joined, { type: 'table_state', table_seq: 13, seats });
    expect(snapshot.seats.find((seat) => seat.seat === 2)).toMatchObject({
      name: null,
      stack: 0,
      status: 'empty',
    });
    const next = reduceMessage(snapshot, {
      type: 'resync_response',
      to_table_seq: 14,
      snapshot: { seats: [{ seat: 5, name: 'Replacement', stack: 2430, bet: 0 }] },
    });
    expect(next.seats).toHaveLength(1);
    expect(next.seats[0]?.stack).toBe(2430);
  });
});
