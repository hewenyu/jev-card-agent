import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Policy, Proposal } from '../src/core/types.js';
import { arena, createRuntime, joined, resync, send } from './helpers/runtime-arena.js';

const choice: Proposal = {
  source: 'jev',
  selected: 'check',
  candidateId: 'check',
  explanation: 'Jev selected check',
  latencyMs: 1,
};

async function interruptedTurn(
  policy: Policy,
  recovery: (ws: WebSocket) => void,
  options: { turnTimeoutMs?: number; decisionTimeoutMs?: number; ageMs?: number } = {},
) {
  let socket: WebSocket | undefined;
  let issuedAt = 0;
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
      });
      send(ws, {
        type: 'hole_cards',
        table_id: 't1',
        hand_id: 'h1',
        table_seq: 101,
        cards: ['Ah', 'Kd'],
      });
      issuedAt = Date.now() - (options.ageMs ?? 0);
      send(ws, {
        type: 'your_turn',
        table_id: 't1',
        hand_id: 'h1',
        table_seq: 104,
        ts: new Date(issuedAt).toISOString(),
        turn_token: 'token-1',
        pot: 40,
        valid_actions: [{ action: 'check' }, { action: 'fold' }],
      });
    }
    if (message.type === 'resync_request') recovery(ws);
    if (message.type === 'action')
      send(ws, {
        type: 'action_ack',
        client_action_id: message.client_action_id,
        status: 'accepted',
      });
  });
  const created = createRuntime(urls, undefined, policy);
  await created.runtime.start({
    strategy: 'jev',
    reconnectMinMs: 1,
    reconnectMaxMs: 2,
    submissionReserveMs: 10,
    turnTimeoutMs: options.turnTimeoutMs ?? 5000,
    decisionTimeoutMs: options.decisionTimeoutMs ?? 4000,
  });
  return {
    ...created,
    urls,
    socket: () => socket!,
    issuedAt: () => issuedAt,
    finish: () =>
      send(socket!, {
        type: 'hand_result',
        table_id: 't1',
        hand_id: 'h1',
        table_seq: 120,
      }),
  };
}

describe('strict Jev reconnect deadline recovery', () => {
  it('reuses the original deadline for the same turn, cancels the old call and submits once despite late results and duplicate snapshots', async () => {
    const resolves: ((proposal: Proposal) => void)[] = [];
    const signals: AbortSignal[] = [];
    const policy: Policy = {
      decide: vi.fn((_context, _candidates, options) => {
        signals.push(options!.signal!);
        return new Promise<Proposal>((resolve) => resolves.push(resolve));
      }),
    };
    const run = await interruptedTurn(policy, (ws) => resync(ws, 'h1', 'token-1'), { ageMs: 1000 });
    await vi.waitFor(() => expect(resolves).toHaveLength(1));
    run.socket().terminate();
    await vi.waitFor(() => expect(resolves).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    resync(run.socket(), 'h1', 'token-1');
    resolves[0]!(choice);
    await vi.waitFor(() => expect(run.store.decisions[0]?.status).toBe('cancelled'));
    expect(run.urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    resolves[1]!(choice);
    await vi.waitFor(() => expect([...run.store.actions.values()][0]?.status).toBe('accepted'));
    resync(run.socket(), 'h1', 'token-1');
    run.finish();
    await vi.waitFor(() => expect(run.runtime.status().state.complete).toBe(true));
    await run.runtime.settleDecisions();
    expect(policy.decide).toHaveBeenCalledTimes(2);
    expect(run.store.blocks).toHaveLength(0);
    expect(run.urls.messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect([...run.store.actions.values()][0]).toMatchObject({
      decisionSource: 'jev',
      deadlineAt: run.issuedAt() + 5000,
    });
  });

  it('does not grant a new deadline when the known turn expires before resync', async () => {
    let respond: (() => void) | undefined;
    const policy = { decide: vi.fn(() => new Promise<Proposal>(() => {})) };
    const run = await interruptedTurn(
      policy,
      (ws) => {
        respond = () => resync(ws, 'h1', 'token-1');
      },
      { turnTimeoutMs: 300 },
    );
    await vi.waitFor(() => expect(policy.decide).toHaveBeenCalledTimes(1));
    run.socket().terminate();
    await vi.waitFor(() => expect(respond).toBeDefined());
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, run.issuedAt() + 310 - Date.now())),
    );
    respond!();
    await vi.waitFor(() => expect(run.store.blocks).toHaveLength(1));
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(
      run.store.decisions.find((decision) => decision.status === 'failed')?.fallbackReason,
    ).toBe('decision_deadline_elapsed');
    expect(run.urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    run.finish();
  });

  it('does not reset the first decision timeout while time remains on the platform turn', async () => {
    let respond: (() => void) | undefined;
    const policy = { decide: vi.fn(() => new Promise<Proposal>(() => {})) };
    const run = await interruptedTurn(
      policy,
      (ws) => {
        respond = () => resync(ws, 'h1', 'token-1');
      },
      { decisionTimeoutMs: 300 },
    );
    await vi.waitFor(() => expect(policy.decide).toHaveBeenCalledTimes(1));
    run.socket().terminate();
    await vi.waitFor(() => expect(respond).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 350));
    respond!();
    await vi.waitFor(() => expect(run.store.blocks).toHaveLength(1));
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(
      run.store.decisions.find((decision) => decision.status === 'failed')?.fallbackReason,
    ).toBe('insufficient_time');
    expect(run.urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    run.finish();
  });

  it('does not borrow the previous deadline for a new recovered token', async () => {
    const policy = { decide: vi.fn(() => new Promise<Proposal>(() => {})) };
    const run = await interruptedTurn(policy, (ws) => resync(ws, 'h1', 'unobserved-token'));
    await vi.waitFor(() => expect(policy.decide).toHaveBeenCalledTimes(1));
    run.socket().terminate();
    await vi.waitFor(() => expect(run.store.blocks).toHaveLength(1));
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(
      run.store.decisions.find((decision) => decision.status === 'failed')?.fallbackReason,
    ).toBe('recovered_turn_unknown_remaining_time');
    expect(run.urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    run.finish();
  });
});
