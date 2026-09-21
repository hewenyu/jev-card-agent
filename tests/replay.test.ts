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
