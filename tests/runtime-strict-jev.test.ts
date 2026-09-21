import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import * as core from '../src/core/index.js';
import { JevProvider } from '../src/policies/jev.js';
import type { Proposal } from '../src/core/types.js';
import {
  arena,
  createRuntime,
  joined,
  MemoryStore,
  resync,
  send,
  turn,
} from './helpers/runtime-arena.js';

function result(ws: WebSocket) {
  send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
}

describe('strict live Jev runtime', () => {
  it('retains failed decisions, sends no local action, and leaves only after the hand ends', async () => {
    let socket: WebSocket | undefined;
    const policy = {
      decide: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
    };
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const { runtime, store } = createRuntime(urls, undefined, policy);
    await runtime.start({ strategy: 'jev' });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopping'));
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]).toMatchObject({
      status: 'failed',
      fallbackReason: 'provider unavailable',
      proposal: { source: 'unavailable', selected: '' },
    });
    expect(store.blocks).toHaveLength(1);
    expect(
      urls.messages.filter((message) => ['action', 'leave_table'].includes(String(message.type))),
    ).toHaveLength(0);
    send(socket!, {
      type: 'your_turn',
      table_id: 't1',
      hand_id: 'h1',
      table_seq: 105,
      turn_token: 'next-token',
      valid_actions: [{ action: 'check' }],
    });
    // A server timeout fold is an observed event, never a client decision or action.
    send(socket!, {
      type: 'player_action',
      table_id: 't1',
      hand_id: 'h1',
      table_seq: 106,
      seat: 0,
      action: 'fold',
      timeout: true,
    });
    result(socket!);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(store.actions.size).toBe(0);
    expect(urls.messages.filter((message) => message.type === 'join_lobby')).toHaveLength(1);
    expect(store.events.some((event) => JSON.stringify(event).includes('"timeout":true'))).toBe(
      true,
    );
  });

  it('does not submit a late success after the total decision deadline', async () => {
    let socket: WebSocket | undefined;
    let finish: ((value: Proposal) => void) | undefined;
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const { runtime, store } = createRuntime(urls, undefined, {
      decide: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await runtime.start({ strategy: 'jev', decisionTimeoutMs: 15 });
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
    finish!({
      source: 'jev',
      selected: 'check',
      candidateId: 'check',
      explanation: 'late',
      latencyMs: 300,
    });
    result(socket!);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    expect(store.decisions[0]?.status).toBe('failed');
  });

  it('records unknown recovery time and never resubmits an old local fallback', async () => {
    let socket: WebSocket | undefined;
    const store = new MemoryStore();
    store.actions.set('old', {
      id: 'old',
      runId: 'old-run',
      decisionId: 'old-decision',
      tableId: 't1',
      status: 'sent',
      decisionSource: 'fallback',
      createdAt: new Date().toISOString(),
      deadlineAt: Date.now() + 10000,
      payload: {
        type: 'action',
        action: 'check',
        hand_id: 'h1',
        turn_token: 'cold-token',
        client_action_id: 'old',
      },
    });
    const policy = { decide: vi.fn() };
    const urls = await arena(
      (ws, message) => {
        socket = ws;
        if (message.type === 'resync_request') resync(ws, 'h1', 'cold-token');
      },
      { playing: true, table_id: 't1', seat: 0 },
    );
    const { runtime } = createRuntime(urls, store, policy);
    await runtime.start({ strategy: 'jev' });
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
    expect(store.decisions[0]?.fallbackReason).toBe('recovered_turn_unknown_remaining_time');
    result(socket!);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(policy.decide).not.toHaveBeenCalled();
    expect(
      urls.messages.some((message) => ['action', 'join_lobby'].includes(String(message.type))),
    ).toBe(false);
  });

  it('lets the Jev provider complete three retries and submits only its fourth successful choice', async () => {
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length < 4) return new Response('', { status: 503 });
      return Response.json({
        model: 'jev-1.13.0',
        usage: { input_tokens: 100, output_tokens: 0 },
        answers: {
          action: {
            type: 'choice',
            choice: 'check',
            confidence: 0.9,
            probabilities: { check: 0.9, fold: 0.1 },
          },
        },
      });
    });
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action') {
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
        result(ws);
      }
    });
    const { runtime, store } = createRuntime(
      urls,
      undefined,
      new JevProvider({ apiKey: 'test', timeoutMs: 10000, fetch: fetcher }),
    );
    await runtime.start({ strategy: 'jev', maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'), { timeout: 3000 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(store.decisions[0]?.proposal.attempts?.map((attempt) => attempt.retryIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(store.decisions[0]?.proposal.source).toBe('jev');
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(store.blocks).toHaveLength(0);
  });
  it('retains every exhausted retry and never turns provider failure into a client fold', async () => {
    let socket: WebSocket | undefined;
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const { runtime, store } = createRuntime(
      urls,
      undefined,
      new JevProvider({ apiKey: 'test', timeoutMs: 10000, fetch: fetcher }),
    );
    await runtime.start({ strategy: 'jev' });
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1), { timeout: 3000 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(store.decisions[0]?.proposal.attempts).toHaveLength(4);
    expect(store.decisions[0]?.status).toBe('failed');
    result(socket!);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
  });

  it('resubmits only the exact persisted Jev action when recovering a known decision', async () => {
    const store = new MemoryStore();
    const payload = {
      type: 'action' as const,
      action: 'check' as const,
      hand_id: 'h1',
      turn_token: 'cold-token',
      client_action_id: 'jev-action',
    };
    store.actions.set('jev-action', {
      id: 'jev-action',
      runId: 'old-run',
      decisionId: 'old-decision',
      tableId: 't1',
      status: 'sent',
      decisionSource: 'jev',
      createdAt: new Date().toISOString(),
      deadlineAt: Date.now() + 10000,
      payload,
    });
    const policy = { decide: vi.fn() };
    const urls = await arena(
      (ws, message) => {
        if (message.type === 'resync_request') resync(ws, 'h1', 'cold-token');
        if (message.type === 'action') {
          expect(message).toEqual(payload);
          send(ws, {
            type: 'action_ack',
            client_action_id: message.client_action_id,
            status: 'accepted',
          });
          result(ws);
        }
      },
      { playing: true, table_id: 't1', seat: 0 },
    );
    const { runtime } = createRuntime(urls, store, policy);
    await runtime.start({ strategy: 'jev', maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(policy.decide).not.toHaveBeenCalled();
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(store.blocks).toHaveLength(0);
  });
  it('pauses without a model call or action when candidate preparation returns no legal option', async () => {
    let socket: WebSocket | undefined;
    const candidates = vi.spyOn(core, 'buildCandidates').mockReturnValue([]);
    try {
      const policy = { decide: vi.fn() };
      const urls = await arena((ws, message) => {
        socket = ws;
        if (message.type === 'join_lobby') {
          joined(ws);
          turn(ws, 1);
        }
      });
      const { runtime, store } = createRuntime(urls, undefined, policy);
      await runtime.start({ strategy: 'jev' });
      await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
      expect(store.decisions[0]).toMatchObject({
        status: 'failed',
        fallbackReason: 'no_legal_candidates',
        candidates: [],
        proposal: { source: 'unavailable', selected: '' },
      });
      expect(policy.decide).not.toHaveBeenCalled();
      expect(runtime.status().phase).toBe('stopping');
      expect(urls.messages.some((message) => message.type === 'leave_table')).toBe(false);
      result(socket!);
      await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
      expect(store.actions.size).toBe(0);
      expect(urls.messages.some((message) => message.type === 'action')).toBe(false);
    } finally {
      candidates.mockRestore();
    }
  });

  it('records a now-illegal Jev choice and drains instead of leaving an unfinished decision behind', async () => {
    let socket: WebSocket | undefined;
    let finish: ((value: Proposal) => void) | undefined;
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const { runtime, store } = createRuntime(urls, undefined, {
      decide: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await runtime.start({ strategy: 'jev' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    send(socket!, {
      type: 'table_state',
      table_id: 't1',
      hand_id: 'h1',
      table_seq: 105,
      actor_seat: 0,
      hero: { seat: 0, valid_actions: [{ action: 'fold' }] },
    });
    await vi.waitFor(() =>
      expect(runtime.state.validActions.map((action) => action.action)).toEqual(['fold']),
    );
    finish!({
      source: 'jev',
      selected: 'check',
      candidateId: 'check',
      explanation: 'Jev chose from the original legal options',
      latencyMs: 50,
      response: { chosen: 'check' },
    });
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
    expect(store.decisions[0]).toMatchObject({
      status: 'failed',
      fallbackReason: 'candidate_no_longer_legal',
      proposal: { source: 'unavailable', selected: '', response: { chosen: 'check' } },
    });
    expect(runtime.status().phase).toBe('stopping');
    expect(
      urls.messages.some((message) =>
        ['action', 'leave_table', 'resync_request'].includes(String(message.type)),
      ),
    ).toBe(false);
    result(socket!);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(store.actions.size).toBe(0);
    expect(urls.messages.filter((message) => message.type === 'join_lobby')).toHaveLength(1);
  });
});
