import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { DecisionContext, Proposal } from '../src/core/types.js';
import { decisionStateKey } from '../src/runtime/authority.js';
import { arena, createRuntime, joined, send } from './helpers/runtime-arena.js';

const choice: Proposal = {
  source: 'jev',
  candidateId: 'check',
  selected: 'check',
  explanation: 'Controlled Jev decision',
  latencyMs: 20,
};
const validActions = [{ action: 'check' }, { action: 'fold' }];
const hero = {
  seat: 0,
  name: 'hero',
  stack: 2000,
  bet: 20,
  status: 'active',
  in_hand: true,
  folded: false,
};
const opponent = { ...hero, seat: 1, name: 'opponent', stack: 1800 };

function snapshot(ws: WebSocket, sequence: number, status: string, extra = {}, seatExtra = {}) {
  send(ws, {
    type: 'table_state',
    table_id: 't1',
    hand_id: 'h1',
    table_seq: sequence,
    actor_seat: 0,
    street: 'preflop',
    pot: 40,
    hero: { seat: 0, valid_actions: validActions },
    seats: [hero, { ...opponent, status, ...seatExtra }],
    ...extra,
  });
}

async function controlledArena(status: string) {
  let socket: WebSocket | undefined;
  let finish!: (proposal: Proposal) => void;
  const policy = {
    decide: vi.fn(
      (_context: DecisionContext) =>
        new Promise<Proposal>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const urls = await arena((ws, message) => {
    socket = ws;
    if (message.type === 'join_lobby') {
      joined(ws);
      send(ws, {
        type: 'hand_start',
        table_id: 't1',
        hand_id: 'h1',
        table_seq: 100,
        seat: 0,
        blinds: { small_blind: 10, big_blind: 20 },
      });
      send(ws, {
        type: 'hole_cards',
        table_id: 't1',
        hand_id: 'h1',
        table_seq: 101,
        cards: ['Ah', 'Kd'],
      });
      snapshot(ws, 102, status);
      send(ws, {
        type: 'your_turn',
        table_id: 't1',
        hand_id: 'h1',
        table_seq: 103,
        turn_token: 'turn-1',
        pot: 40,
        valid_actions: validActions,
        // A partial your_turn player summary can omit the disconnected opponent.
        players: [hero],
      });
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
  await vi.waitFor(() => expect(policy.decide).toHaveBeenCalledTimes(1));
  return { runtime, store, urls, policy, socket: socket!, finish };
}

describe('connection status changes during a Jev decision', () => {
  it.each([
    ['active', 'disconnected'],
    ['disconnected', 'active'],
  ])('submits one original Jev result across %s → %s', async (before, after) => {
    const { runtime, store, urls, policy, socket, finish } = await controlledArena(before!);
    const original = runtime.state;
    const context = policy.decide.mock.calls[0]![0];
    snapshot(socket, 104, after!);
    await vi.waitFor(() => expect(runtime.state.lastTableSeq).toBe(104));

    expect(runtime.state.seats[1]?.status).toBe(after);
    expect(context.seats[1]?.status).toBe(before);
    expect(context.harness?.betting.activeOpponents).toBe(1);
    // Recovery of a pending action uses the same identity without history.
    expect(decisionStateKey(runtime.state, false)).toBe(decisionStateKey(original, false));
    finish(choice);
    await vi.waitFor(() => expect([...store.actions.values()][0]?.status).toBe('accepted'));

    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(store.blocks).toHaveLength(0);
    expect(store.decisions[0]?.proposal.source).toBe('jev');
    expect(store.decisions[0]?.context.seats[1]?.status).toBe(before);
    expect(store.checkpoint?.state.seats[1]?.status).toBe(after);
    expect(runtime.status().phase).toBe('playing');
  });

  it.each([
    { changed: 'stack', seat: { stack: 1700 } },
    { changed: 'bet', seat: { bet: 40 } },
    { changed: 'participation', seat: { in_hand: false } },
    { changed: 'folded', seat: { folded: true } },
    { changed: 'unknown status', seat: { status: 'unknown-server-status' } },
    { changed: 'other known status', seat: { status: 'sitting_out' } },
    { changed: 'pot', table: { pot: 80 } },
    {
      changed: 'legal actions',
      table: {
        hero: {
          seat: 0,
          valid_actions: [...validActions, { action: 'raise', min: 40, max: 2000 }],
        },
      },
    },
  ])('still rejects a decision when $changed changes alongside disconnection', async (change) => {
    const { runtime, store, urls, policy, socket, finish } = await controlledArena('active');
    snapshot(socket, 104, 'disconnected', change.table, change.seat);
    await vi.waitFor(() => expect(runtime.state.lastTableSeq).toBe(104));
    finish(choice);
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1));

    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(store.decisions[0]).toMatchObject({
      status: 'failed',
      fallbackReason: 'decision_state_changed',
    });
    expect(store.actions.size).toBe(0);
    expect(urls.messages.some((message) => message.type === 'action')).toBe(false);
  });
});
