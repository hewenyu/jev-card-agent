import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { DecisionContext, Proposal } from '../src/core/types.js';
import { arena, createRuntime, joined, send } from './helpers/runtime-arena.js';

const choice: Proposal = {
  source: 'jev',
  candidateId: 'check',
  selected: 'check',
  explanation: 'Controlled Jev choice for the supplied decision context',
  latencyMs: 20,
};
const validActions = [{ action: 'check' }, { action: 'fold' }];
const players = [
  { seat: 0, name: 'hero', stack: 2000, bet: 0, status: 'active', in_hand: true },
  { seat: 1, name: 'other', stack: 1800, bet: 0, status: 'active', in_hand: true },
];
const newcomer = { seat: 2, name: 'newcomer', stack: 4000, bet: 0, status: 'active' };

function startHand(ws: WebSocket, hand: number, includeNewcomer = false) {
  send(ws, {
    type: 'hand_start',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: hand * 100,
    seat: 0,
    blinds: { small_blind: 10, big_blind: 20 },
  });
  send(ws, {
    type: 'hole_cards',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: hand * 100 + 1,
    cards: ['Ah', 'Kd'],
  });
  snapshot(ws, hand, hand * 100 + 2, {
    seats: includeNewcomer ? [...players, { ...newcomer, in_hand: true }] : players,
  });
}

function snapshot(ws: WebSocket, hand: number, sequence: number, extra = {}) {
  send(ws, {
    type: 'table_state',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: sequence,
    actor_seat: 0,
    street: 'preflop',
    pot: 40,
    hero: { seat: 0, valid_actions: validActions },
    ...extra,
  });
}

function requestAction(ws: WebSocket, hand: number, sequence = hand * 100 + 4, extra = {}) {
  send(ws, {
    type: 'your_turn',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: sequence,
    turn_token: `token-${sequence}`,
    pot: 40,
    valid_actions: validActions,
    ...extra,
  });
}

function seatNewcomer(ws: WebSocket, sequence: number) {
  send(ws, {
    type: 'player_joined',
    table_id: 't1',
    hand_id: 'h1',
    table_seq: sequence,
    ...newcomer,
  });
}

function endHand(ws: WebSocket, hand: number) {
  send(ws, {
    type: 'hand_result',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: hand * 100 + 20,
  });
}

async function controlledArena(beforeRequest?: (ws: WebSocket) => void, turnSummary = false) {
  let socket: WebSocket | undefined;
  const finish: ((proposal: Proposal) => void)[] = [];
  const policy = {
    decide: vi.fn(
      (_context: DecisionContext) =>
        new Promise<Proposal>((resolve) => {
          finish.push(resolve);
        }),
    ),
  };
  const urls = await arena((ws, message) => {
    socket = ws;
    if (message.type === 'join_lobby') {
      joined(ws);
      startHand(ws, 1);
      beforeRequest?.(ws);
      requestAction(ws, 1, 104, turnSummary ? { players: [...players, newcomer] } : {});
    }
    if (message.type === 'action') {
      send(ws, {
        type: 'action_ack',
        client_action_id: message.client_action_id,
        status: 'accepted',
      });
    }
  });
  const { runtime, store } = createRuntime(urls, undefined, policy);
  await runtime.start({ strategy: 'jev' });
  await vi.waitFor(() => expect(finish).toHaveLength(1));
  return { runtime, store, policy, finish, urls, socket: socket! };
}

describe('live seat membership while Jev is deciding', () => {
  it.each(['before', 'after', 'summary'] as const)(
    'accepts the original Jev result when a waiting player joins %s the request, then includes them next hand',
    async (arrival) => {
      const { runtime, store, policy, finish, urls, socket } = await controlledArena(
        arrival === 'before' ? (ws) => seatNewcomer(ws, 103) : undefined,
        arrival === 'summary',
      );
      const firstContext = policy.decide.mock.calls[0]![0];
      expect(firstContext.harness?.betting.activeOpponents).toBe(1);
      expect(firstContext.effectiveStack).toBe(1800);
      if (arrival !== 'after') {
        expect(firstContext.seats.find((seat) => seat.seat === 2)?.inHand).toBe(false);
      } else {
        expect(firstContext.seats.some((seat) => seat.seat === 2)).toBe(false);
        seatNewcomer(socket, 105);
      }
      await vi.waitFor(() =>
        expect(runtime.state.seats.find((seat) => seat.seat === 2)?.inHand).toBe(false),
      );
      // Deliver the official membership completion while the one Jev call is pending.
      snapshot(socket, 1, 106, {
        seats: [...players, { ...newcomer, in_hand: false }],
      });
      await vi.waitFor(() => expect(runtime.state.lastTableSeq).toBe(106));
      if (arrival === 'summary') {
        // Actual server order: your_turn → table_state → player_joined.
        seatNewcomer(socket, 107);
        await vi.waitFor(() => expect(runtime.state.lastTableSeq).toBe(107));
      }
      expect(store.actions.size).toBe(0);
      finish[0]!(choice);
      await vi.waitFor(() => expect([...store.actions.values()][0]?.status).toBe('accepted'));
      expect(policy.decide).toHaveBeenCalledTimes(1);
      expect(store.blocks).toHaveLength(0);
      expect(store.decisions[0]?.proposal.source).toBe('jev');

      endHand(socket, 1);
      startHand(socket, 2, true);
      requestAction(socket, 2);
      await vi.waitFor(() => expect(policy.decide).toHaveBeenCalledTimes(2));
      const secondContext = policy.decide.mock.calls[1]![0];
      expect(secondContext.seats.find((seat) => seat.seat === 2)?.inHand).toBe(true);
      expect(secondContext.harness?.betting.activeOpponents).toBe(2);
      expect(secondContext.effectiveStack).toBe(2000);
      finish[1]!(choice);
      await vi.waitFor(() =>
        expect([...store.actions.values()].map((action) => action.status)).toEqual([
          'accepted',
          'accepted',
        ]),
      );
      expect(store.blocks).toHaveLength(0);
      expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(2);
      expect(store.decisions.every((decision) => decision.proposal.source === 'jev')).toBe(true);
      endHand(socket, 2);
    },
  );

  it.each(['pot', 'active opponent stack', 'participation', 'call price'] as const)(
    'still rejects the old Jev result when the %s really changes with the same turn token',
    async (changed) => {
      const { runtime, store, finish, urls, socket } = await controlledArena(undefined, true);
      snapshot(socket, 1, 105, {
        pot: changed === 'pot' ? 80 : 40,
        hero: {
          seat: 0,
          valid_actions: changed === 'call price' ? [{ action: 'call', amount: 20 }] : validActions,
        },
        seats: [
          players[0],
          { ...players[1], stack: changed === 'active opponent stack' ? 1700 : 1800 },
          { ...newcomer, in_hand: changed === 'participation' },
        ],
      });
      await vi.waitFor(() => expect(runtime.state.lastTableSeq).toBe(105));
      finish[0]!(choice);
      await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
      expect(store.decisions[0]).toMatchObject({
        status: 'failed',
        fallbackReason:
          changed === 'call price' ? 'candidate_no_longer_legal' : 'decision_state_changed',
      });
      expect(store.actions.size).toBe(0);
      expect(urls.messages.some((message) => message.type === 'action')).toBe(false);
      endHand(socket, 1);
      await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    },
  );

  it.each(['hand', 'turn token'] as const)(
    'cancels an old answer after the %s changes and only sends the new authorized Jev answer',
    async (changed) => {
      const { runtime, store, policy, finish, urls, socket } = await controlledArena();
      const hand = changed === 'hand' ? 2 : 1;
      if (changed === 'hand') {
        endHand(socket, 1);
        startHand(socket, 2);
      }
      requestAction(socket, hand, hand * 100 + 5);
      await vi.waitFor(() => expect(policy.decide).toHaveBeenCalledTimes(2));
      finish[0]!(choice);
      await vi.waitFor(() => expect(store.decisions[0]?.status).toBe('cancelled'));
      expect(store.actions.size).toBe(0);
      expect(urls.messages.some((message) => message.type === 'action')).toBe(false);
      finish[1]!(choice);
      await vi.waitFor(() => expect([...store.actions.values()][0]?.status).toBe('accepted'));
      expect(store.blocks).toHaveLength(0);
      const actions = urls.messages.filter((message) => message.type === 'action');
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        hand_id: `h${hand}`,
        turn_token: `token-${hand * 100 + 5}`,
      });
      endHand(socket, hand);
      expect(runtime.status().phase).not.toBe('failed');
    },
  );
});
