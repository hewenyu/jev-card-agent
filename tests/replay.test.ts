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
