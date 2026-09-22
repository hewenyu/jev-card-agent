import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { BaselinePolicy } from '../src/policies/baseline.js';
import type { Policy } from '../src/core/types.js';
import {
  arena,
  createRuntime,
  joined,
  MemoryStore,
  resync,
  send,
  turn,
} from './helpers/runtime-arena.js';

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
    await runtime.start({ strategy: 'baseline', maxHands: 3 });
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
    await runtime.start({
      strategy: 'baseline',
      maxHands: 1,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
    });
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
    await runtime.start({ strategy: 'baseline', maxHands: 1 });
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
    await runtime.start({ strategy: 'baseline', maxHands: 1, decisionTimeoutMs: 15 });
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
    await runtime.start({ strategy: 'baseline' });
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
    await runtime.start({ strategy: 'baseline' });
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
    await runtime.start({ strategy: 'baseline', maxHands: 1 });
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
    await runtime.start({ strategy: 'baseline' });
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
    await runtime.start({ strategy: 'baseline', maxHands: 1 });
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
    await runtime.start({ strategy: 'baseline', autoRebuy: false });
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
    await runtime.start({ strategy: 'baseline', maxHands: 1 });
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
    await runtime.start({ strategy: 'baseline' });
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
    await runtime.start({ strategy: 'baseline' });
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
    await runtime.start({ strategy: 'baseline' });
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
    await runtime.start({ strategy: 'baseline', maxHands: 1 });
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
    await runtime.start({ strategy: 'baseline', maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'), { timeout: 2500 });
    expect(urls.messages.filter((message) => message.type === 'join_lobby')).toHaveLength(1);
    expect(urls.messages.filter((message) => message.type === 'resync_request')).toHaveLength(1);
  });

  it('cancels a queued rate-limit retry when stopped', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') send(ws, { type: 'error', code: 'rate_limited' });
    });
    const { runtime } = createRuntime(urls);
    await runtime.start({ strategy: 'baseline' });
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
      await runtime.start({ strategy: 'baseline', ...options });
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
    await runtime.start({ strategy: 'baseline', gracefulStopTimeoutMs: 30 });
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
    await runtime.start({ strategy: 'baseline', gracefulStopTimeoutMs: 0 });
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
    await runtime.start({ strategy: 'baseline', maxHands: 2, buyIn: 2000, autoRebuy: true });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(runtime.status().hands).toBe(2);
    expect(joins).toBe(2);
    expect(urls.messages.filter((message) => message.type === 'rebuy')).toHaveLength(0);
  });
  it('reconciles account events from a departed table before table sequence filtering', async () => {
    let socket: WebSocket | undefined;
    let available = 2000;
    const urls = await arena(
      (ws, message) => {
        if (message.type === 'join_lobby') {
          socket = ws;
          joined(ws);
          send(ws, {
            type: 'hand_start',
            table_id: 't1',
            hand_id: 'funding-hand',
            table_seq: 100,
            seat: 0,
          });
        }
      },
      { playing: false },
      true,
      () => ({ chip_balance: available, chips_at_table: 0, auto_rebuy: true }),
    );
    const { runtime } = createRuntime(urls);
    await runtime.start({ strategy: 'baseline' });
    await vi.waitFor(() => expect(runtime.state.lastTableSeq).toBe(100));
    send(socket!, {
      type: 'auto_rebuy_scheduled',
      table_id: 'departed-table',
      table_seq: 1,
      cooldown_seconds: 300,
    });
    await vi.waitFor(() => {
      expect(runtime.status().phase).toBe('cooldown');
      expect(runtime.status().funding?.rebuyAvailableAt).not.toBeNull();
    });
    available = 1500;
    send(socket!, {
      type: 'rebuy_confirmed',
      table_id: 'departed-table',
      table_seq: 1,
      chip_balance: 99999,
    });
    await vi.waitFor(() => {
      expect(runtime.status().funding).toMatchObject({
        availableChips: 1500,
        status: 'current',
        rebuyAvailableAt: null,
      });
      expect(urls.messages.filter((message) => message.type === 'join_lobby')).toHaveLength(2);
    });
    runtime.stop(false);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(runtime.status().funding).toMatchObject({
      status: 'current',
      availableChips: 1500,
      chipsAtTable: 0,
      seasonScore: null,
    });
  });
});
