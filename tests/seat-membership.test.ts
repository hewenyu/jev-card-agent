import { describe, expect, it } from 'vitest';
import { createInitialState, reduceMessage } from '../src/core/index.js';
import type { PokerState, RawMessage } from '../src/core/types.js';
import { decisionStateKey } from '../src/runtime/authority.js';

function table() {
  return reduceMessage(createInitialState(), {
    type: 'table_joined',
    table_id: 'table',
    seat: 0,
    players: [
      { seat: 0, name: 'hero', stack: 1980 },
      { seat: 2, name: 'opponent', stack: 1990 },
    ],
  });
}

function hand() {
  let state = reduceMessage(table(), { type: 'hand_start', hand_id: 'hand', table_seq: 1 });
  state = reduceMessage(state, {
    type: 'table_state',
    table_seq: 2,
    street: 'preflop',
    pot: 30,
    actor_seat: 0,
    hero: { seat: 0 },
    seats: [
      { seat: 0, name: 'hero', stack: 1980, bet: 20, in_hand: true },
      { seat: 2, name: 'opponent', stack: 1990, bet: 10, in_hand: true },
    ],
  });
  return state;
}

function join(state: PokerState, fields: RawMessage = {}) {
  return reduceMessage(state, {
    type: 'player_joined',
    table_seq: state.lastTableSeq + 1,
    seat: 1,
    name: 'newcomer',
    stack: 1500,
    ...fields,
  });
}

function seatSnapshot(state: PokerState, fields: RawMessage = {}) {
  return {
    type: 'table_state',
    table_seq: state.lastTableSeq + 1,
    street: state.street,
    actor_seat: state.actorSeat,
    pot: state.pot,
    board: state.board,
    hero: { seat: state.heroSeat, valid_actions: state.validActions },
    seats: state.seats.map(({ inHand, ...seat }) => ({ ...seat, in_hand: inHand })),
    ...fields,
  };
}

describe('current-hand membership on occupancy events', () => {
  it('excludes a mid-hand newcomer before Jev starts and keeps the decision valid when the server confirms it', () => {
    const joined = join(hand());
    expect(joined.seats.find((s) => s.seat === 1)?.inHand).toBe(false);
    const turn = reduceMessage(joined, {
      type: 'your_turn',
      table_seq: 4,
      turn_token: 'turn',
      pot: 30,
      players: [{ seat: 1, name: 'newcomer', stack: 1500 }],
      valid_actions: [{ action: 'check' }],
    });
    const confirmed = reduceMessage(turn, seatSnapshot(turn));
    expect(confirmed.turnToken).toBe('turn');
    expect(decisionStateKey(confirmed)).toBe(decisionStateKey(turn));
    expect(confirmed.seats.find((s) => s.seat === 1)?.inHand).toBe(false);
  });

  it.each([true, false, undefined])(
    'preserves known membership %s and commitments on a duplicate notice',
    (inHand) => {
      const before = hand();
      before.seats = before.seats.map((s) =>
        s.seat === 2 ? { ...s, inHand, folded: true, status: 'active' } : s,
      );
      const next = reduceMessage(before, { type: 'player_joined', seat: 2, name: 'opponent' });
      expect(next.seats).toEqual(before.seats);
      expect(decisionStateKey(next)).toBe(decisionStateKey(before));
    },
  );

  it('merges a sparse duplicate notification with no name without removing the occupant', () => {
    const before = hand();
    const next = reduceMessage(before, { type: 'player_joined', seat: 2, stack: 1920 });
    expect(next.seats.find((s) => s.seat === 2)).toMatchObject({
      name: 'opponent',
      stack: 1920,
      bet: 10,
      inHand: true,
    });
  });

  it('replaces a different occupant without inheriting its membership, bet, folded status, or stack', () => {
    const before = hand();
    before.seats = before.seats.map((s) => (s.seat === 2 ? { ...s, folded: true } : s));
    const next = join(before, { seat: 2, name: 'replacement', stack: 1700 });
    expect(next.seats.find((s) => s.seat === 2)).toEqual({
      seat: 2,
      name: 'replacement',
      stack: 1700,
      bet: 0,
      status: 'active',
      inHand: false,
      folded: undefined,
    });
    expect(next.seats).toHaveLength(2);
  });

  it.each([true, false])('respects explicit server membership %s on a new arrival', (inHand) => {
    const joined = join(hand(), { in_hand: inHand, bet: 25 });
    expect(joined.seats.find((s) => s.seat === 1)).toMatchObject({ inHand, bet: 25 });
    const snapshot = reduceMessage(joined, seatSnapshot(joined));
    expect(snapshot.seats).toEqual(joined.seats);
  });

  it('allows an authoritative snapshot to correct inferred membership and invalidate an affected decision', () => {
    const joined = join(hand());
    const snapshot = seatSnapshot(joined);
    snapshot.seats = snapshot.seats.map((s) => (s.seat === 1 ? { ...s, in_hand: true } : s));
    const corrected = reduceMessage(joined, snapshot);
    expect(corrected.seats.find((s) => s.seat === 1)?.inHand).toBe(true);
    expect(decisionStateKey(corrected)).not.toBe(decisionStateKey(joined));
  });

  it('preserves the exclusion across streets and clears it for the next hand', () => {
    const joined = join(hand());
    const flop = reduceMessage(joined, {
      type: 'community_cards',
      table_seq: 4,
      street: 'flop',
      cards: ['Ah', 'Kd', '2c'],
    });
    expect(flop.seats.find((s) => s.seat === 1)?.inHand).toBe(false);
    const another = join(flop, { seat: 3, name: 'later' });
    expect(another.seats.find((s) => s.seat === 3)?.inHand).toBe(false);
    const nextHand = reduceMessage(another, { type: 'hand_start', hand_id: 'next', table_seq: 6 });
    expect(nextHand.seats.every((s) => s.inHand === undefined)).toBe(true);
    const confirmed = reduceMessage(nextHand, {
      ...seatSnapshot(nextHand),
      seats: nextHand.seats.map((s) => ({ ...s, in_hand: true })),
    });
    expect(confirmed.seats.every((s) => s.inHand === true)).toBe(true);
  });

  it('does not exclude an arrival before the first deal or after settlement', () => {
    expect(join(table()).seats.find((s) => s.seat === 1)?.inHand).toBeUndefined();
    const ended = reduceMessage(hand(), { type: 'hand_result', table_seq: 3 });
    expect(join(ended).seats.find((s) => s.seat === 1)?.inHand).toBeUndefined();
  });

  it.each(['between_hands_delay', 'awaiting_hand_start', 'insufficient_players', 'table_closing'])(
    'does not assume a dealt hand during %s, and clears that boundary when a new hand starts',
    (waitingReason) => {
      const waiting = reduceMessage(hand(), {
        ...seatSnapshot(hand()),
        waiting_reason: waitingReason,
      });
      const joined = join(waiting);
      expect(joined.seats.find((s) => s.seat === 1)?.inHand).toBeUndefined();
      const next = reduceMessage(joined, { type: 'hand_start', hand_id: 'next', table_seq: 5 });
      expect(next.waitingReason).toBeNull();
      expect(join(next, { seat: 3 }).seats.find((s) => s.seat === 3)?.inHand).toBe(false);
    },
  );

  it('does not infer a mid-hand arrival when the notification itself first identifies the hand or table', () => {
    const firstHand = join(table(), { hand_id: 'first' });
    expect(firstHand.seats.find((s) => s.seat === 1)?.inHand).toBeUndefined();
    const otherTable = join(hand(), { table_id: 'other', hand_id: 'hand' });
    expect(otherTable.seats.find((s) => s.seat === 1)?.inHand).toBeUndefined();
  });

  it('clears waiting on an explicit hand_start even when the preceding snapshot already names that hand', () => {
    const before = hand();
    const waiting = reduceMessage(before, {
      ...seatSnapshot(before),
      waiting_reason: 'awaiting_hand_start',
    });
    const started = reduceMessage(waiting, {
      type: 'hand_start',
      hand_id: waiting.handId,
      table_seq: waiting.lastTableSeq + 1,
    });
    expect(started.waitingReason).toBeNull();
    expect(started.seats).toEqual(waiting.seats);
    expect(started.history).toEqual(waiting.history);
    expect(join(started).seats.find((s) => s.seat === 1)?.inHand).toBe(false);
  });

  it('ignores malformed seat identifiers without deleting occupied seats', () => {
    const before = hand();
    expect(join(before, { seat: -1 }).seats).toEqual(before.seats);
    expect(join(before, { seat: '2' }).seats).toEqual(before.seats);
  });
});
