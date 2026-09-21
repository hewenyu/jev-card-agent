import { describe, expect, it } from 'vitest';
import type { HandDetail } from '../src/shared/api.js';
import { replayTable } from '../web/src/replay.js';

function handWith(events: { type: string; payload: Record<string, unknown> }[]): HandDetail {
  return {
    hand: {
      id: 'fixture-hand',
      runId: 'fixture-run',
      tableId: 'fixture-table',
      handNumber: 1,
      board: ['As', '7d', '2c', 'Tc', '4h'],
      heroCards: ['Ah', 'Kd'],
      profit: null,
      bigBlind: 20,
      status: 'complete',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      complete: false,
    },
    decisions: [],
    events: events.map((event, index) => ({
      ...event,
      id: String(index),
      receivedAt: `2026-01-01T00:00:0${index}Z`,
    })),
  };
}

describe('recorded replay information boundaries', () => {
  it('installs resync bets once and ignores its separately stored replay rows', () => {
    const action = {
      type: 'player_action',
      hand_id: 'hand',
      table_seq: 4,
      seat: 0,
      action: 'raise',
      amount: 120,
      stack_after: 880,
      contribution_delta: 70,
      pot_after: 120,
    };
    const detail = handWith([
      {
        type: 'table_state',
        payload: {
          hand_id: 'hand',
          table_seq: 1,
          pot: 50,
          seats: [{ seat: 0, name: 'Hero', stack: 950, bet: 50 }],
        },
      },
      {
        type: 'resync_response',
        payload: {
          to_table_seq: 5,
          replayed_events: [action],
          snapshot: {
            hand_id: 'hand',
            pot: 120,
            seats: [{ seat: 0, name: 'Hero', stack: 880, bet: 120 }],
          },
        },
      },
      { type: 'player_action', payload: action },
      { type: 'player_action', payload: { ...action, table_seq: 5 } },
      {
        type: 'player_action',
        payload: {
          ...action,
          table_seq: 6,
          stack_after: 850,
          contribution_delta: 30,
          pot_after: 150,
        },
      },
    ]);
    expect(replayTable(detail, 0)).toMatchObject({ pot: 50, seats: [{ stack: 950, bet: 50 }] });
    for (const cursor of [1, 2, 3])
      expect(replayTable(detail, cursor)).toMatchObject({
        pot: 120,
        seats: [{ stack: 880, bet: 120 }],
      });
    expect(replayTable(detail, 4)).toMatchObject({ pot: 150, seats: [{ stack: 850, bet: 150 }] });
  });

  it('restores settlement markers from replay before installing the final snapshot', () => {
    const result = {
      type: 'hand_result',
      hand_id: 'hand',
      table_seq: 8,
      total_pot: 120,
      final_stacks: { 0: 1120 },
    };
    const detail = handWith([
      {
        type: 'table_state',
        payload: {
          table_seq: 1,
          hand_id: 'hand',
          seats: [{ seat: 0, name: 'Hero', stack: 950, bet: 50 }],
        },
      },
      {
        type: 'resync_response',
        payload: {
          to_table_seq: 9,
          replayed_events: [result],
          snapshot: {
            hand_id: 'hand',
            seats: [{ seat: 0, name: 'Hero', stack: 1120, bet: 0 }],
          },
        },
      },
      { type: 'hand_result', payload: result },
    ]);
    expect(replayTable(detail, 0).complete).toBe(false);
    for (const cursor of [1, 2])
      expect(replayTable(detail, cursor)).toMatchObject({
        complete: true,
        pot: 120,
        seats: [{ stack: 1120, bet: 0 }],
      });
  });

  it('rejects old snapshots for every money field and permits an equal-watermark resync', () => {
    const snapshot = (sequence: number, stack: number, bet: number) => ({
      table_seq: sequence,
      pot: bet,
      street: bet === 30 ? 'flop' : 'preflop',
      seats: [{ seat: 0, name: 'Hero', stack, bet }],
    });
    const detail = handWith([
      { type: 'table_state', payload: snapshot(5, 970, 30) },
      { type: 'table_state', payload: snapshot(4, 1000, 0) },
      {
        type: 'resync_response',
        payload: { to_table_seq: 5, snapshot: snapshot(5, 960, 40) },
      },
      {
        type: 'resync_response',
        payload: { to_table_seq: 4, snapshot: snapshot(4, 1000, 0) },
      },
    ]);
    expect(replayTable(detail, 1)).toMatchObject({
      street: 'flop',
      pot: 30,
      seats: [{ stack: 970, bet: 30 }],
    });
    for (const cursor of [2, 3])
      expect(replayTable(detail, cursor)).toMatchObject({
        pot: 40,
        seats: [{ stack: 960, bet: 40 }],
      });
  });

  it('shows available chips and current bets at each cursor, settling only at the result', () => {
    const detail = handWith([
      {
        type: 'table_state',
        payload: {
          street: 'river',
          pot: 100,
          seats: [{ seat: 0, name: 'Hero', stack: 950, bet: 50 }],
        },
      },
      {
        type: 'player_action',
        payload: {
          seat: 0,
          action: 'raise',
          amount: 120,
          stack: 999,
          stack_after: 880,
          contribution_delta: 70,
          pot_after: 170,
        },
      },
      {
        type: 'hand_result',
        payload: { total_pot: 240, pot: 170, final_stacks: { 0: 1120 } },
      },
    ]);
    expect(replayTable(detail, 0)).toMatchObject({
      complete: false,
      pot: 100,
      seats: [{ stack: 950, bet: 50 }],
    });
    expect(replayTable(detail, 1)).toMatchObject({
      complete: false,
      pot: 170,
      seats: [{ stack: 880, bet: 120 }],
    });
    expect(replayTable(detail, 2)).toMatchObject({
      complete: true,
      pot: 240,
      potKnown: true,
      seats: [{ stack: 1120, bet: 0 }],
    });
    expect(replayTable(detail, 1).seats[0]?.stack).toBe(880);
  });

  it.each(['stack_after', 'player_stack_after', 'stack'])(
    'uses %s for balances and derives contributions without treating raise-to as a delta',
    (field) => {
      const detail = handWith([
        {
          type: 'table_state',
          payload: { seats: [{ seat: 0, name: 'Hero', stack: 950, bet: 50 }] },
        },
        {
          type: 'player_action',
          payload: { seat: 0, action: 'raise', amount: 120, [field]: 880 },
        },
        {
          type: 'player_action',
          payload: { seat: 0, action: 'raise', amount: 180, contribution_delta: 99, bet: 180 },
        },
        {
          type: 'player_action',
          payload: { seat: 0, action: 'raise', amount: 200, contribution_delta: 20 },
        },
        { type: 'player_action', payload: { seat: 0, action: 'raise', amount: 500 } },
      ]);
      expect(replayTable(detail, 1).seats[0]).toMatchObject({ stack: 880, bet: 120 });
      expect(replayTable(detail, 2).seats[0]).toMatchObject({ stack: 880, bet: 180 });
      expect(replayTable(detail, 3).seats[0]).toMatchObject({ stack: 880, bet: 200 });
      expect(replayTable(detail, 4).seats[0]).toMatchObject({ stack: 880, bet: 200 });
    },
  );

  it('clears prior-street bets while preserving explicit new-street bets and same-street summaries', () => {
    const detail = handWith([
      {
        type: 'table_state',
        payload: {
          street: 'preflop',
          seats: [
            { seat: 0, name: 'Hero', stack: 950, bet: 50 },
            { seat: 1, name: 'Opponent', stack: 950, bet: 50 },
          ],
        },
      },
      {
        type: 'your_turn',
        payload: {
          community_cards: ['Ah', 'Kd', '2c'],
          players: [{ seat: 1, stack: 925, bet: 25 }],
        },
      },
      {
        type: 'your_turn',
        payload: { community_cards: ['Ah', 'Kd', '2c'], players: [{ seat: 1, stack: 925 }] },
      },
      { type: 'community_cards', payload: { street: 'turn', cards: ['3d'] } },
    ]);
    expect(replayTable(detail, 0).seats.map((seat) => seat.bet)).toEqual([50, 50]);
    expect(replayTable(detail, 1)).toMatchObject({ street: 'flop' });
    expect(replayTable(detail, 1).seats.map((seat) => seat.bet)).toEqual([0, 25]);
    expect(replayTable(detail, 2).seats.map((seat) => seat.bet)).toEqual([0, 25]);
    expect(replayTable(detail, 3).seats.map((seat) => seat.bet)).toEqual([0, 0]);
  });

  it.each([
    [{ pot: 450 }, 450],
    [{}, 100],
    [{ total_pot: 0, pot: 450 }, 0],
  ])(
    'uses only the recorded settlement pot and resets completion on a new hand: %j',
    (fields, pot) => {
      const detail = handWith([
        { type: 'table_state', payload: { pot: 100 } },
        { type: 'hand_result', payload: fields },
        { type: 'hand_start', payload: { hand_id: 'next' } },
      ]);
      expect(replayTable(detail, 1)).toMatchObject({ complete: true, pot });
      expect(replayTable(detail, 2).complete).toBe(false);
    },
  );

  it('shows only the dealer known at the cursor and clears explicit unknown or new-hand positions', () => {
    const detail = handWith([
      { type: 'hand_start', payload: { hand_id: 'first', table_seq: 1 } },
      { type: 'table_state', payload: { hand_id: 'first', table_seq: 2, dealer_seat: 0 } },
      { type: 'your_turn', payload: { table_seq: 3 } },
      { type: 'table_state', payload: { table_seq: 4, dealer_seat: null } },
      { type: 'table_state', payload: { table_seq: 3, dealer_seat: 5 } },
      {
        type: 'resync_response',
        payload: { to_table_seq: 5, snapshot: { hand_id: 'first', dealer_seat: 3 } },
      },
      { type: 'hand_start', payload: { hand_id: 'next', table_seq: 6 } },
      { type: 'table_state', payload: { hand_id: 'next', table_seq: 7, dealer_seat: 2 } },
    ]);
    expect(replayTable(detail, 0).dealerSeat).toBeNull();
    expect(replayTable(detail, 1).dealerSeat).toBe(0);
    expect(replayTable(detail, 2).dealerSeat).toBe(0);
    expect(replayTable(detail, 3).dealerSeat).toBeNull();
    expect(replayTable(detail, 4).dealerSeat).toBeNull();
    expect(replayTable(detail, 5).dealerSeat).toBe(3);
    expect(replayTable(detail, 6).dealerSeat).toBeNull();
    expect(replayTable(detail, 7).dealerSeat).toBe(2);
    expect(replayTable(detail, 0).dealerSeat).toBeNull();
  });

  it('accepts an authoritative resync at the current watermark and rejects older ones', () => {
    const detail = handWith([
      { type: 'table_state', payload: { hand_id: 'hand', table_seq: 5, dealer_seat: 1 } },
      {
        type: 'resync_response',
        payload: { to_table_seq: 5, snapshot: { hand_id: 'hand', dealer_seat: 0 } },
      },
      {
        type: 'resync_response',
        payload: { to_table_seq: 4, snapshot: { hand_id: 'hand', dealer_seat: 3 } },
      },
    ]);
    expect(replayTable(detail, 1).dealerSeat).toBe(0);
    expect(replayTable(detail, 2).dealerSeat).toBe(0);
  });

  it('merges your_turn player summaries without reviving folded seats or erasing bets', () => {
    const detail = handWith([
      {
        type: 'table_state',
        payload: {
          pot: 80,
          board: [],
          hero: { seat: 4 },
          seats: [
            { seat: 0, name: 'Seat zero', stack: 950, bet: 50, folded: true, status: 'folded' },
            { seat: 4, name: 'Hero', stack: 980, bet: 20, folded: false, status: 'active' },
          ],
        },
      },
      {
        type: 'your_turn',
        payload: {
          seat: 4,
          pot: 80,
          community_cards: [],
          players: [
            { seat: 0, name: 'Seat zero', stack: 950 },
            { seat: 4, name: 'Hero', stack: 980 },
          ],
        },
      },
    ]);
    const replay = replayTable(detail, 1);
    expect(replay.seats.find((seat) => seat.seat === 0)).toMatchObject({
      folded: true,
      status: 'folded',
      bet: 50,
    });
    expect(replay.seats.find((seat) => seat.seat === 4)).toMatchObject({ folded: false, bet: 20 });
    expect(replay.heroSeat).toBe(4);
    expect(replay.board).toEqual([]);
    expect(replay.heroCards).toEqual([]);
  });

  it('shows the seat supplied on joining and reveals cards only when the recorded event supplies them', () => {
    const detail = handWith([
      {
        type: 'table_joined',
        payload: { seat: 4, players: [{ seat: 4, name: 'Hero', stack: 1000 }] },
      },
      { type: 'hole_cards', payload: { cards: ['Ah', 'Kd'] } },
      { type: 'community_cards', payload: { street: 'flop', cards: ['As', '7d', '2c'] } },
      { type: 'community_cards', payload: { street: 'turn', cards: ['Tc'] } },
      { type: 'community_cards', payload: { street: 'river', cards: ['4h'] } },
    ]);
    expect(replayTable(detail, 0)).toMatchObject({
      heroSeat: 4,
      heroCards: [],
      board: [],
      potKnown: false,
    });
    expect(replayTable(detail, 1)).toMatchObject({ heroCards: ['Ah', 'Kd'], board: [] });
    expect(replayTable(detail, 2).board).toEqual(['As', '7d', '2c']);
    expect(replayTable(detail, 3).board).toEqual(['As', '7d', '2c', 'Tc']);
    expect(replayTable(detail, 4).board).toEqual(detail.hand.board);
  });
});
