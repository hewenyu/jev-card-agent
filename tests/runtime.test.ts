import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { PokerRuntime } from '../src/runtime/runtime.js';
import { BaselinePolicy } from '../src/policies/baseline.js';
import type { Policy } from '../src/core/types.js';
import type {
  DecisionRecord,
  RuntimeCheckpoint,
  RuntimeStore,
  StoredAction,
} from '../src/runtime/types.js';

class MemoryStore implements RuntimeStore {
  assertRuntimeLease() {}
  actions = new Map<string, StoredAction>();
  decisions: DecisionRecord[] = [];
  events: unknown[] = [];
  checkpoint: RuntimeCheckpoint | null = null;
  beginRun() {}
  finishRun() {}
  appendEvent(...args: unknown[]) {
    this.events.push(args);
  }
  saveDecision(value: DecisionRecord) {
    this.decisions.push(value);
  }
  prepareAction(value: StoredAction) {
    this.actions.set(value.id, structuredClone(value));
  }
  updateAction(id: string, status: StoredAction['status']) {
    const action = this.actions.get(id);
    if (action) action.status = status;
  }
  pendingActions() {
    return [...this.actions.values()].filter((a) => !['accepted', 'rejected'].includes(a.status));
  }
  saveCheckpoint(value: RuntimeCheckpoint) {
    this.checkpoint = structuredClone(value);
  }
  loadCheckpoint() {
    return this.checkpoint;
  }
  saveHand() {}
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function arena(
  handler: (ws: WebSocket, message: Record<string, unknown>, connection: number) => void,
  activeGame: Record<string, unknown> | (() => Record<string, unknown>) = { playing: false },
  confirmLeave = true,
  seasonBalance: () => Record<string, unknown> = () => ({
    chip_balance: 5000,
    chips_at_table: 0,
    pro_tier: false,
    auto_rebuy: true,
  }),
) {
  let connection = 0;
  const messages: Record<string, unknown>[] = [];
  const http = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer test-secret');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/season/me') {
      response.end(JSON.stringify(seasonBalance()));
      return;
    }
    response.end(JSON.stringify(typeof activeGame === 'function' ? activeGame() : activeGame));
  });
  const server = new WebSocketServer({ server: http });
  server.on('connection', (ws, request) => {
    expect(request.headers.authorization).toBe('Bearer test-secret');
    const index = ++connection;
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString()) as Record<string, unknown>;
      messages.push(message);
      handler(ws, message, index);
      if (confirmLeave && message.type === 'leave_table')
        send(ws, { type: 'error', code: 'not_at_table' });
    });
    send(ws, { type: 'connected', agent_id: 'hero', name: 'hero' });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { wsUrl: `ws://127.0.0.1:${port}`, restUrl: `http://127.0.0.1:${port}`, messages };
}
function send(ws: WebSocket, value: Record<string, unknown>) {
  ws.send(JSON.stringify(value));
}
function joined(ws: WebSocket) {
  send(ws, {
    type: 'table_joined',
    table_id: 't1',
    seat: 0,
    players: [
      { seat: 0, name: 'hero', stack: 2000 },
      { seat: 1, name: 'other', stack: 2000 },
    ],
  });
}
function turn(ws: WebSocket, hand: number, sequence = hand * 100) {
  send(ws, {
    type: 'hand_start',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: sequence,
    seat: 0,
    blinds: { small_blind: 10, big_blind: 20 },
  });
  send(ws, {
    type: 'hole_cards',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: sequence + 1,
    cards: ['Ah', 'Kd'],
  });
  const value = {
    type: 'your_turn',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: sequence + 4,
    turn_token: `token-${hand}`,
    pot: 40,
    valid_actions: [{ action: 'check' }, { action: 'fold' }],
  };
  send(ws, value);
  return value;
}
function resync(ws: WebSocket, hand: string, token: string, sequence = 110) {
  send(ws, {
    type: 'resync_response',
    table_id: 't1',
    hand_id: hand,
    to_table_seq: sequence,
    role: 'player',
    replayed_events: [],
    snapshot: {
      type: 'table_state',
      table_id: 't1',
      hand_id: hand,
      actor_seat: 0,
      street: 'preflop',
      pot: 40,
      hero: {
        seat: 0,
        turn_token: token,
        hole_cards: ['Ah', 'Kd'],
        valid_actions: [{ action: 'check' }, { action: 'fold' }],
      },
      seats: [{ seat: 0, name: 'hero', stack: 2000, bet: 0, status: 'active' }],
    },
  });
}
function createRuntime(
  urls: { wsUrl: string; restUrl: string },
  store = new MemoryStore(),
  policy: Policy = new BaselinePolicy(),
) {
  const runtime = new PokerRuntime({ ...urls, apiKey: 'test-secret', store, policy });
  cleanups.unshift(async () => {
    runtime.stop(false);
    await vi.waitFor(() => expect(['stopped', 'idle', 'failed']).toContain(runtime.status().phase));
  });
  return { runtime, store };
}

describe('OpenPoker runtime against an actual local WebSocket server', () => {
  it('automatically completes multiple hands, persists before send, ignores duplicate turns and stops at its hand limit', async () => {
    const store = new MemoryStore();
    let count = 0;
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        const event = turn(ws, 1);
        send(ws, event);
      }
      if (message.type === 'action') {
        expect(store.actions.has(String(message.client_action_id))).toBe(true);
        count++;
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
          hand_id: message.hand_id,
        });
        send(ws, {
          type: 'hand_result',
          table_id: 't1',
          hand_id: message.hand_id,
          table_seq: count * 100 + 9,
          final_stacks: { '0': 2000, '1': 2000 },
        });
        if (count < 3) turn(ws, count + 1);
      }
    });
    const { runtime } = createRuntime(urls, store);
    await runtime.start({ maxHands: 3 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(count).toBe(3);
    expect(store.decisions).toHaveLength(3);
    expect([...store.actions.values()].every((a) => a.status === 'accepted')).toBe(true);
    expect(urls.messages.filter((m) => m.type === 'resync_request')).toHaveLength(0);
  });

  it('reconnects, resyncs and retries the exact durable action without another policy call', async () => {
    const submitted: Record<string, unknown>[] = [];
    const policy = { decide: vi.fn(new BaselinePolicy().decide) };
    const urls = await arena((ws, message, connection) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action') {
        submitted.push(message);
        if (connection === 1) ws.terminate();
        else {
          send(ws, {
            type: 'action_ack',
            client_action_id: message.client_action_id,
            status: 'accepted',
          });
          send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
        }
      }
      if (message.type === 'resync_request') resync(ws, 'h1', 'token-1');
    });
    const { runtime, store } = createRuntime(urls, undefined, policy);
    await runtime.start({ maxHands: 1, reconnectMinMs: 1, reconnectMaxMs: 2 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect([...store.actions.values()][0]?.status).toBe('accepted');
  });

  it('cold recovery uses quick legal fallback and does not join another lobby', async () => {
    const policy = { decide: vi.fn(new BaselinePolicy().decide) };
    const urls = await arena(
      (ws, message) => {
        if (message.type === 'resync_request') resync(ws, 'h1', 'cold-token');
        if (message.type === 'action') {
          expect(message.action).toBe('check');
          send(ws, {
            type: 'action_ack',
            client_action_id: message.client_action_id,
            status: 'accepted',
          });
          send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
        }
      },
      { playing: true, table_id: 't1', seat: 0 } as { playing: boolean },
    );
    const { runtime, store } = createRuntime(urls, undefined, policy);
    await runtime.start({ maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(policy.decide).not.toHaveBeenCalled();
    expect(store.decisions[0]?.fallbackReason).toBe('recovered_turn_unknown_remaining_time');
    expect(urls.messages.some((m) => m.type === 'join_lobby')).toBe(false);
  });

  it('times out a hung policy once and ignores its late result', async () => {
    let resolvePolicy: ((value: Awaited<ReturnType<Policy['decide']>>) => void) | undefined;
    const policy: Policy = {
      decide: () =>
        new Promise((resolve) => {
          resolvePolicy = resolve;
        }),
    };
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action') {
        expect(message.action).toBe('check');
        resolvePolicy?.({
          candidateId: 'fold',
          selected: 'fold',
          source: 'jev',
          explanation: 'late',
          latencyMs: 200,
        });
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
        send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
      }
    });
    const { runtime, store } = createRuntime(urls, undefined, policy);
    await runtime.start({ maxHands: 1, decisionTimeoutMs: 15 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]?.proposal.source).toBe('fallback');
    expect(urls.messages.filter((m) => m.type === 'action')).toHaveLength(1);
  });

  it('never sends an action when write-ahead persistence fails', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const store = new MemoryStore();
    store.prepareAction = () => {
      throw new Error('disk full');
    };
    const { runtime } = createRuntime(urls, store);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.status().phase).toBe('failed'));
    expect(runtime.status().lastError).toBe('disk full');
    expect(urls.messages.filter((m) => m.type === 'action')).toHaveLength(0);
  });

  it('a plain table_state never authorizes a model call', async () => {
    const policy = { decide: vi.fn(new BaselinePolicy().decide) };
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        send(ws, {
          type: 'table_state',
          table_id: 't1',
          hand_id: 'h1',
          table_seq: 1,
          actor_seat: 0,
          hero: { seat: 0, turn_token: 'unexpected-token', valid_actions: [{ action: 'check' }] },
        });
      }
    });
    const { runtime } = createRuntime(urls, undefined, policy);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.status().state.handId).toBe('h1'));
    runtime.stop(false);
    expect(policy.decide).not.toHaveBeenCalled();
  });
  it('falls back after policy rejection and injects observations into the next decision', async () => {
    const policy: Policy = {
      decide: vi.fn(async (context) => {
        expect(context.opponents[0]?.name).toBe('other');
        expect(context.opponents[0]?.vpip).toBe(1);
        throw new Error('provider unavailable');
      }),
    };
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        send(ws, { type: 'hand_start', table_id: 't1', hand_id: 'h1', table_seq: 1, seat: 0 });
        send(ws, {
          type: 'player_action',
          table_id: 't1',
          hand_id: 'h1',
          table_seq: 2,
          seat: 1,
          name: 'other',
          action: 'call',
          amount: 20,
          street: 'preflop',
          to_call_before: 20,
        });
        send(ws, {
          type: 'your_turn',
          table_id: 't1',
          hand_id: 'h1',
          table_seq: 8,
          turn_token: 'turn1',
          valid_actions: [{ action: 'fold' }, { action: 'call', amount: 20 }],
        });
      }
      if (message.type === 'action') {
        expect(message.action).toBe('fold');
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
        send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 10 });
      }
    });
    const { runtime, store } = createRuntime(urls, undefined, policy);
    await runtime.start({ maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(store.decisions[0]?.fallbackReason).toBe('provider unavailable');
    expect(policy.decide).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncorrelated rejected action after recovery', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action')
        send(ws, { type: 'action_rejected', code: 'invalid_action', reason: 'invalid' });
      if (message.type === 'resync_request') resync(ws, 'h1', 'token-1');
    });
    const { runtime } = createRuntime(urls);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.status().state.lastTableSeq).toBe(110));
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1);
    runtime.stop(false);
  });

  it('cancels an in-flight decision when a new hand takes authority', async () => {
    let calls = 0;
    const policy: Policy = {
      decide: async (context, candidates) => {
        calls++;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 100));
        return new BaselinePolicy().decide(context, candidates);
      },
    };
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
        setTimeout(() => turn(ws, 2), 10);
      }
      if (message.type === 'action') {
        expect(message.hand_id).toBe('h2');
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
        send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h2', table_seq: 220 });
      }
    });
    const { runtime, store } = createRuntime(urls, undefined, policy);
    await runtime.start({ maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    await runtime.settleDecisions();
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(store.decisions.find((decision) => decision.handId === 'h1')?.status).toBe('cancelled');
    expect([...store.actions.values()].every((action) => action.payload.hand_id === 'h2')).toBe(
      true,
    );
  });
  it('requeues after table closure and a season change, then cleanly leaves when busted with auto-rebuy disabled', async () => {
    let joins = 0;
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joins++;
        joined(ws);
        if (joins === 1) send(ws, { type: 'table_closed', reason: 'insufficient_players' });
        else if (joins === 2)
          send(ws, { type: 'season_ended', season_number: 1, next_season_number: 2 });
        else send(ws, { type: 'busted', options: ['rebuy', 'leave'] });
      }
    });
    const { runtime } = createRuntime(urls);
    await runtime.start({ autoRebuy: false });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(joins).toBe(3);
    expect(urls.messages.filter((message) => message.type === 'rebuy')).toHaveLength(0);
    expect(
      urls.messages
        .filter((message) => message.type === 'set_auto_rebuy')
        .every((message) => message.enabled === false),
    ).toBe(true);
  });

  it('applies replay before the authoritative final snapshot without counting historical hands toward the live limit', async () => {
    const urls = await arena(
      (ws, message) => {
        if (message.type === 'resync_request') {
          expect(message.last_table_seq).toBe(0);
          send(ws, {
            type: 'resync_response',
            table_id: 't1',
            role: 'player',
            to_table_seq: 50,
            replayed_events: [
              {
                type: 'hand_result',
                table_id: 't1',
                hand_id: 'historical',
                table_seq: 20,
                final_stacks: { '0': 1800 },
              },
              { type: 'hand_start', table_id: 't1', hand_id: 'historical', table_seq: 10, seat: 0 },
              {
                type: 'player_action',
                table_id: 't1',
                hand_id: 'current',
                table_seq: 40,
                seat: 0,
                name: 'hero',
                action: 'call',
                amount: 20,
                stack: 1780,
                pot: 40,
              },
            ],
            snapshot: {
              type: 'table_state',
              table_id: 't1',
              hand_id: 'current',
              actor_seat: 1,
              pot: 100,
              seats: [{ seat: 0, name: 'hero', stack: 1700, bet: 80, status: 'active' }],
              hero: { seat: 0 },
            },
          });
        }
      },
      { playing: true, table_id: 't1', seat: 0 } as { playing: boolean },
    );
    const { runtime, store } = createRuntime(urls);
    await runtime.start({ maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().state.lastTableSeq).toBe(50));
    expect(
      store.events.filter(
        (entry) =>
          Array.isArray(entry) && (entry[1] as Record<string, unknown>).type === 'player_action',
      ),
    ).toHaveLength(1);
    expect(runtime.status().hands).toBe(0);
    expect(runtime.status().state.seats[0]?.stack).toBe(1700);
    expect(runtime.status().state.pot).toBe(100);
    expect(runtime.status().state.handId).toBe('current');
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    runtime.stop(false);
  });
  it('fences an action if the database lease changes while the model is thinking', async () => {
    const store = new MemoryStore();
    const policy: Policy = {
      decide: async (context, candidates) => {
        store.assertRuntimeLease = () => {
          throw new Error('Runtime lease lost');
        };
        return new BaselinePolicy().decide(context, candidates);
      },
    };
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const { runtime } = createRuntime(urls, store, policy);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.status().phase).toBe('failed'));
    expect(runtime.status().lastError).toBe('Runtime lease lost');
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
  });

  it('fences a paid policy call when the lease is already lost', async () => {
    const store = new MemoryStore();
    store.assertRuntimeLease = () => {
      throw new Error('Runtime lease expired');
    };
    const policy = { decide: vi.fn(new BaselinePolicy().decide) };
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const { runtime } = createRuntime(urls, store, policy);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.status().phase).toBe('failed'));
    expect(policy.decide).not.toHaveBeenCalled();
  });
  it('stops immediately at an idle boundary and verifies the seat through REST when leave acknowledgement is missing', async () => {
    let restRequests = 0;
    const urls = await arena(
      (ws, message) => {
        if (message.type === 'join_lobby') {
          joined(ws);
          send(ws, {
            type: 'table_state',
            table_id: 't1',
            hand_id: 'old-hand',
            hand_seq: null,
            table_seq: 1,
            street: 'idle',
            actor_seat: null,
            waiting_reason: 'between_hands_delay',
          });
        }
      },
      () => {
        restRequests++;
        return { playing: false, table_id: null, seat: null };
      },
      false,
    );
    const { runtime } = createRuntime(urls);
    await runtime.start();
    await vi.waitFor(() =>
      expect(runtime.status().state.waitingReason).toBe('between_hands_delay'),
    );
    runtime.stop(true);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'), { timeout: 2500 });
    expect(restRequests).toBe(2);
    expect(urls.messages.filter((message) => message.type === 'leave_table')).toHaveLength(1);
  });
  it('retries a rate-limited lobby join before a table exists and completes a hand', async () => {
    let joins = 0;
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joins++;
        if (joins === 1) send(ws, { type: 'error', code: 'rate_limited' });
        else {
          joined(ws);
          turn(ws, 1);
        }
      }
      if (message.type === 'action') {
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
        send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
      }
    });
    const { runtime } = createRuntime(urls);
    await runtime.start({ maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'), { timeout: 2500 });
    expect(joins).toBe(2);
    expect(runtime.status().hands).toBe(1);
    expect(urls.messages.filter((message) => message.type === 'resync_request')).toHaveLength(0);
  });

  it('resyncs a rate-limited seated connection without joining a second lobby', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        send(ws, { type: 'error', code: 'rate_limited' });
      }
      if (message.type === 'resync_request') resync(ws, 'h1', 'limited-turn');
      if (message.type === 'action') {
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
        send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
      }
    });
    const { runtime } = createRuntime(urls);
    await runtime.start({ maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'), { timeout: 2500 });
    expect(urls.messages.filter((message) => message.type === 'join_lobby')).toHaveLength(1);
    expect(urls.messages.filter((message) => message.type === 'resync_request')).toHaveLength(1);
  });

  it('cancels a queued rate-limit retry when stopped', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') send(ws, { type: 'error', code: 'rate_limited' });
    });
    const { runtime } = createRuntime(urls);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.status().lastError).toBe('rate_limited'));
    runtime.stop(true);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(urls.messages.filter((message) => message.type === 'join_lobby')).toHaveLength(1);
    expect(urls.messages.filter((message) => message.type === 'resync_request')).toHaveLength(0);
  });
  it.each([{}, { gracefulStopTimeoutMs: 0 }])(
    'drains the current hand without a default timer (%j)',
    async (options) => {
      let table: WebSocket | undefined;
      const urls = await arena((ws, message) => {
        if (message.type === 'join_lobby') {
          table = ws;
          joined(ws);
          turn(ws, 1);
        }
        if (message.type === 'action')
          send(ws, {
            type: 'action_ack',
            client_action_id: message.client_action_id,
            status: 'accepted',
          });
      });
      const { runtime } = createRuntime(urls);
      await runtime.start(options);
      await vi.waitFor(() =>
        expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1),
      );
      const timer = vi.spyOn(globalThis, 'setTimeout');
      try {
        runtime.stop(true);
        expect(timer).not.toHaveBeenCalled();
      } finally {
        timer.mockRestore();
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(runtime.status().phase).toBe('stopping');
      expect(urls.messages.filter((message) => message.type === 'leave_table')).toHaveLength(0);
      send(table!, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
      await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
      expect(urls.messages.filter((message) => message.type === 'leave_table')).toHaveLength(1);
    },
  );

  it('honors an explicitly configured finite emergency drain timeout', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action')
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
    });
    const { runtime } = createRuntime(urls);
    await runtime.start({ gracefulStopTimeoutMs: 30 });
    await vi.waitFor(() =>
      expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1),
    );
    runtime.stop(true);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(urls.messages.filter((message) => message.type === 'leave_table')).toHaveLength(1);
  });
  it('finishes an unlimited drain when an authoritative idle snapshot arrives', async () => {
    let table: WebSocket | undefined;
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        table = ws;
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action')
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
    });
    const { runtime } = createRuntime(urls);
    await runtime.start({ gracefulStopTimeoutMs: 0 });
    await vi.waitFor(() =>
      expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1),
    );
    runtime.stop(true);
    expect(urls.messages.filter((message) => message.type === 'leave_table')).toHaveLength(0);
    send(table!, {
      type: 'table_state',
      table_id: 't1',
      hand_id: null,
      table_seq: 120,
      street: 'idle',
      actor_seat: null,
      waiting_reason: 'between_hands_delay',
    });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(urls.messages.filter((message) => message.type === 'leave_table')).toHaveLength(1);
  });
  it('continues after a server automatic 1500-chip rebuy using the available balance', async () => {
    let balance = 2000;
    let joins = 0;
    const urls = await arena(
      (ws, message) => {
        if (message.type === 'join_lobby') {
          joins++;
          expect(message.buy_in).toBe(joins === 1 ? 2000 : 1500);
          joined(ws);
          turn(ws, joins);
        }
        if (message.type === 'action') {
          send(ws, {
            type: 'action_ack',
            client_action_id: message.client_action_id,
            status: 'accepted',
          });
          send(ws, {
            type: 'hand_result',
            table_id: 't1',
            hand_id: message.hand_id,
            table_seq: joins * 100 + 10,
            final_stacks: { '0': joins === 1 ? 0 : 1500 },
          });
          if (joins === 1) {
            balance = 0;
            send(ws, { type: 'table_closed', reason: 'busted' });
            send(ws, { type: 'auto_rebuy_scheduled', cooldown_seconds: 0 });
            setTimeout(() => {
              balance = 1500;
              send(ws, { type: 'rebuy_confirmed', new_stack: 0, chip_balance: 1500 });
            }, 10);
          }
        }
      },
      { playing: false },
      true,
      () => ({ chip_balance: balance, chips_at_table: 0, pro_tier: false, auto_rebuy: true }),
    );
    const { runtime } = createRuntime(urls);
    await runtime.start({ maxHands: 2, buyIn: 2000, autoRebuy: true });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(runtime.status().hands).toBe(2);
    expect(joins).toBe(2);
    expect(urls.messages.filter((message) => message.type === 'rebuy')).toHaveLength(0);
  });
});
