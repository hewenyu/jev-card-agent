import { describe, expect, it } from 'vitest';
import { buildContext, createInitialState, reduceMessage } from '../src/core/index.js';

describe('authoritative dealer position', () => {
  it('updates the button from server events, retains omitted same-hand fields and rejects stale positions', () => {
    let state = reduceMessage(createInitialState(), {
      type: 'hand_start',
      table_id: 'table',
      hand_id: 'hand',
      table_seq: 1,
      dealer_seat: 0,
    });
    expect(state.dealerSeat).toBe(0);
    state = reduceMessage(state, { type: 'your_turn', table_seq: 2, players: [] });
    expect(state.dealerSeat).toBe(0);
    state = reduceMessage(state, { type: 'table_state', table_seq: 4, dealer_seat: 5 });
    expect(buildContext(state).dealerSeat).toBe(5);
    expect(reduceMessage(state, { type: 'table_state', table_seq: 3, dealer_seat: 2 })).toBe(state);
    expect(
      reduceMessage(state, {
        type: 'resync_response',
        to_table_seq: 3,
        snapshot: { dealer_seat: 2 },
      }),
    ).toBe(state);
    state = reduceMessage(state, {
      type: 'resync_response',
      to_table_seq: 5,
      snapshot: { hand_id: 'hand', dealer_seat: 3 },
    });
    expect(state.dealerSeat).toBe(3);
  });

  it('clears unknown positions on new hands, tables and explicit null without guessing the next dealer', () => {
    let state = reduceMessage(createInitialState(), {
      type: 'hand_start',
      table_id: 'table',
      hand_id: 'hand',
      table_seq: 1,
      dealer_seat: 0,
    });
    state = reduceMessage(state, { type: 'hand_start', hand_id: 'next', table_seq: 2 });
    expect(state.dealerSeat).toBeNull();
    state = reduceMessage(state, { type: 'table_state', table_seq: 3, dealer_seat: 4 });
    expect(state.dealerSeat).toBe(4);
    state = reduceMessage(state, { type: 'table_state', table_seq: 4, dealer_seat: null });
    expect(state.dealerSeat).toBeNull();
    state = reduceMessage(state, { type: 'your_turn', table_seq: 5, dealer_seat: 1 });
    expect(state.dealerSeat).toBe(1);
    state = reduceMessage(state, { type: 'table_joined', table_id: 'another', seat: 0 });
    expect(state.dealerSeat).toBeNull();
    state = reduceMessage(state, { type: 'table_state', table_seq: 1, dealer_seat: 6 });
    expect(state.dealerSeat).toBeNull();
  });
});
