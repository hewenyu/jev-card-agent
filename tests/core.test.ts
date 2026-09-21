import { describe, expect, it } from 'vitest';
import {
  buildCandidates,
  buildContext,
  createInitialState,
  OpponentTracker,
  reduceMessage,
  validateCandidate,
} from '../src/core/index.js';

function fixture() {
  let state = reduceMessage(createInitialState(), {
    type: 'table_joined',
    table_id: 't',
    seat: 2,
    players: [
      { seat: 0, name: 'opponent', stack: 2000 },
      { seat: 2, name: 'hero', stack: 2000 },
    ],
  });
  state = reduceMessage(state, {
    type: 'hand_start',
    hand_id: 'h',
    table_seq: 1,
    seat: 2,
    dealer_seat: 0,
  });
  return reduceMessage(state, {
    type: 'your_turn',
    hand_id: 'h',
    table_seq: 5,
    turn_token: 'turn',
    pot: 30,
    valid_actions: [
      { action: 'fold' },
      { action: 'call', amount: 20 },
      { action: 'raise', min: 40, max: 2000 },
      { action: 'all_in', amount: 2000 },
    ],
  });
}
describe('V2 state boundaries', () => {
  it('trusts a player resync token without optional actor_seat and clears spectator private state', () => {
    const restored = reduceMessage(fixture(), {
      type: 'resync_response',
      role: 'player',
      to_table_seq: 7,
      snapshot: {
        hand_id: 'h',
        hero: {
          seat: 2,
          hole_cards: ['Ah', 'Ad'],
          valid_actions: [{ action: 'check' }],
          turn_token: 'restored',
        },
      },
    });
    expect(restored.turnToken).toBe('restored');
    expect(restored.actorSeat).toBe(2);
    const spectator = reduceMessage(restored, {
      type: 'resync_response',
      role: 'spectator',
      to_table_seq: 8,
      snapshot: { hand_id: 'h' },
    });
    expect(spectator.holeCards).toEqual([]);
    expect(spectator.turnToken).toBeNull();
  });
  it('revokes turn authorization when a later action advances the game', () => {
    const next = reduceMessage(fixture(), {
      type: 'player_action',
      table_seq: 6,
      seat: 0,
      action: 'check',
    });
    expect(next.turnToken).toBeNull();
    expect(next.validActions).toEqual([]);
  });
  it('accepts sequence jumps, ignores duplicate/regressing events and preserves null action amounts', () => {
    const state = fixture();
    const next = reduceMessage(state, {
      type: 'player_action',
      table_seq: 10,
      seat: 0,
      action: 'fold',
      amount: null,
      street: 'preflop',
      stack: 2000,
      pot: 30,
    });
    expect(next.history).toHaveLength(1);
    expect(next.history[0]?.amount).toBeNull();
    expect(
      reduceMessage(next, { type: 'player_action', table_seq: 10, seat: 0, action: 'fold' }),
    ).toBe(next);
    expect(reduceMessage(next, { type: 'table_state', table_seq: 9, pot: 9999 })).toBe(next);
  });
  it('ordinary snapshots cannot authorize action, and authoritative false clears prior folds', () => {
    const state = fixture();
    const next = reduceMessage(state, {
      type: 'player_action',
      table_seq: 6,
      seat: 0,
      action: 'fold',
    });
    const snapshot = reduceMessage(next, {
      type: 'table_state',
      table_seq: 7,
      actor_seat: 0,
      seats: [
        {
          seat: 0,
          name: 'opponent',
          status: 'active',
          stack: 2000,
          bet: 0,
          in_hand: true,
          folded: false,
        },
      ],
      hero: { seat: 2, turn_token: 'forged', valid_actions: [{ action: 'check' }] },
    });
    expect(snapshot.turnToken).toBeNull();
    expect(snapshot.seats[0]?.folded).toBe(false);
  });
  it('replays history before installing final snapshot, without adding contribution twice', () => {
    const next = reduceMessage(fixture(), {
      type: 'resync_response',
      role: 'player',
      to_table_seq: 20,
      replayed_events: [
        {
          type: 'player_action',
          table_seq: 12,
          seat: 0,
          name: 'opponent',
          action: 'raise',
          amount: 60,
          stack: 1940,
          pot: 90,
        },
        {
          type: 'player_action',
          table_seq: 12,
          seat: 0,
          name: 'opponent',
          action: 'raise',
          amount: 60,
          stack: 1940,
          pot: 90,
        },
      ],
      snapshot: {
        hand_id: 'h',
        pot: 90,
        actor_seat: 2,
        seats: [{ seat: 0, name: 'opponent', stack: 1940, bet: 60 }],
        hero: { seat: 2, turn_token: 'restored', valid_actions: [{ action: 'fold' }] },
      },
    });
    expect(next.history).toHaveLength(1);
    expect(next.seats[0]?.bet).toBe(60);
    expect(next.turnToken).toBe('restored');
    expect(next.lastTableSeq).toBe(20);
  });
  it('clears private cards, authorization and prior hand history on a new hand', () => {
    const next = reduceMessage(
      { ...fixture(), holeCards: ['Ah', 'Ad'] },
      { type: 'hand_start', hand_id: 'new', table_seq: 30 },
    );
    expect(next.holeCards).toEqual([]);
    expect(next.turnToken).toBeNull();
    expect(next.handStartStacks['2']).toBe(2000);
  });
  it('appends a single turn/river card and accepts complete board snapshots', () => {
    let state = reduceMessage(fixture(), {
      type: 'community_cards',
      table_seq: 6,
      street: 'flop',
      cards: ['Ah', 'Kd', '2s'],
    });
    state = reduceMessage(state, {
      type: 'community_cards',
      table_seq: 7,
      street: 'turn',
      cards: ['3s'],
    });
    state = reduceMessage(state, {
      type: 'community_cards',
      table_seq: 8,
      street: 'river',
      cards: ['Ah', 'Kd', '2s', '3s', '4s'],
    });
    expect(state.board).toEqual(['Ah', 'Kd', '2s', '3s', '4s']);
  });
});
describe('legal candidates and visible context', () => {
  it('uses raise-entry limits and emits amount only for raise', () => {
    const state = fixture();
    const candidates = buildCandidates(state);
    expect(candidates.every((c) => validateCandidate(c, state))).toBe(true);
    expect(candidates.find((c) => c.action === 'raise')?.amount).toBe(40);
    expect(
      candidates.filter((c) => c.action !== 'raise').every((c) => c.amount === undefined),
    ).toBe(true);
    expect(validateCandidate({ id: 'bad', action: 'raise', amount: 39, label: '' }, state)).toBe(
      false,
    );
    expect(validateCandidate({ id: 'bad', action: 'raise', amount: 40.5, label: '' }, state)).toBe(
      false,
    );
    expect(buildCandidates({ ...state, turnToken: null })).toEqual([]);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
  });
  it('freezes decision information without turn credentials or future updates', () => {
    const state = fixture();
    const context = buildContext(state);
    state.seats[0]!.stack = 0;
    expect(context.seats[0]?.stack).toBe(2000);
    expect(context).not.toHaveProperty('turnToken');
    expect(context.potOdds).toBe(0.4);
  });
  it('counts only observed opponent opportunities and deduplicates replay', () => {
    const tracker = new OpponentTracker();
    const state = reduceMessage(fixture(), {
      type: 'player_action',
      table_seq: 6,
      seat: 0,
      name: 'opponent',
      action: 'fold',
      street: 'preflop',
      to_call_before: 20,
    });
    tracker.observe(state);
    tracker.observe(state);
    expect(tracker.snapshot()).toEqual([
      { name: 'opponent', hands: 1, vpip: 0, pfr: 0, facedBet: 1, foldedToBet: 1, lastTableSeq: 6 },
    ]);
    expect(buildContext(state, tracker.snapshot()).opponents[0]?.hands).toBe(1);
    const restarted = new OpponentTracker(
      JSON.parse(JSON.stringify(tracker.exportState())) as ReturnType<
        OpponentTracker['exportState']
      >,
    );
    restarted.observe(state);
    expect(restarted.snapshot()).toEqual(tracker.snapshot());
  });
  it('bounds opponent replay dedup while retaining cumulative statistics', () => {
    const tracker = new OpponentTracker();
    for (let hand = 0; hand < 1005; hand++) {
      const state = reduceMessage(fixture(), {
        type: 'player_action',
        hand_id: `hand-${hand}`,
        table_seq: 6,
        seat: 0,
        name: 'opponent',
        action: 'call',
        street: 'preflop',
      });
      tracker.observe(state);
    }
    expect(tracker.exportState().recent).toHaveLength(1000);
    expect(tracker.snapshot()[0]?.hands).toBe(1005);
  });
});
