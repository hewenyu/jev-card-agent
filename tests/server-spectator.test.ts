import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { SpectatorFeed } from '../src/server/spectator.js';
import { openSpectatorStream } from '../src/server/spectator-stream.js';
import { Store } from '../src/storage/store.js';
import type { EvaluationView, RuntimeView, SpectatorSnapshot } from '../src/shared/api.js';
import type { ServerEvent } from '../src/openpoker/protocol.js';

function view(seq = 10, handId = 'hand-1', runId = 'run-1'): RuntimeView {
  return {
    running: true,
    status: 'playing',
    mode: 'live',
    runId,
    strategy: 'jev',
    error: 'private-error',
    table: {
      tableId: 'table-1',
      handId,
      street: 'flop',
      pot: 300,
      board: ['2h', '3h', '4h'],
      heroCards: ['As', 'Ad'],
      heroSeat: 0,
      dealerSeat: 1,
      actorSeat: 2,
      stateSeq: seq,
      complete: false,
      seats: [
        { seat: 0, name: 'Hero', stack: 1800, bet: 200, folded: false, status: 'active' },
        { seat: 1, name: 'Opponent', stack: 1900, bet: 100, folded: false, status: 'active' },
      ],
    },
  };
}
const action = (seq: number, fields: Record<string, unknown> = {}): ServerEvent => ({
  type: 'player_action',
  table_id: 'table-1',
  hand_id: 'hand-1',
  table_seq: seq,
  seat: 0,
  action: 'raise',
  amount: 200,
  turn_token: 'must-never-publish-token',
  hole_cards: ['As', 'Ad'],
  ...fields,
});

describe('public spectator projection', () => {
  it('publishes only public table fields and known chip contributions, never raise-to totals', () => {
    const feed = new SpectatorFeed(view());
    feed.update(view(), [
      action(1, { contribution_delta: 50 }),
      action(2, { stack_before: 2000, stack_after: 1950 }),
      action(3),
      action(4, { action: 'check', contribution_delta: 0 }),
    ]);
    const snapshot = feed.current();
    expect(snapshot.runtime.table?.board).toEqual(['2h', '3h', '4h']);
    expect(snapshot.runtime.table?.actorSeat).toBe(2);
    expect(snapshot.runtime.table?.heroCards).toEqual(['As', 'Ad']);
    expect(snapshot.runtime.error).toBeNull();
    expect(snapshot.recentEvents.map((event) => event.movements.map((m) => m.amount))).toEqual([
      [50],
      [50],
      [],
      [],
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/must-never|private-error|hole_cards|turn_token/);
    expect(snapshot.recentEvents[3]?.action).toBe('check');
  });

  it('uses payout arrays, deduplicates reconnect events and retains only the current hand and run', () => {
    const feed = new SpectatorFeed(view());
    const payout: ServerEvent = {
      type: 'hand_result',
      table_id: 'table-1',
      hand_id: 'hand-1',
      table_seq: 5,
      payouts: [
        { seat: 0, amount: 180 },
        { seat: 1, amount: 120 },
      ],
    };
    feed.update(view(), [action(1, { contribution_delta: 50 }), payout]);
    const expected = feed.current().recentEvents;
    expect(expected[1]?.movements.map((movement) => [movement.direction, movement.amount])).toEqual(
      [
        ['from-pot', 180],
        ['from-pot', 120],
      ],
    );
    feed.update(view(), [action(1, { contribution_delta: 50 }), payout]);
    expect(feed.current().recentEvents).toEqual(expected);
    feed.update(view(11, 'hand-2'), [action(10), payout]);
    expect(feed.current().recentEvents).toEqual([]);
    feed.update(view(1, 'hand-1', 'run-2'), [action(1, { contribution_delta: 10 })]);
    expect(feed.current().recentEvents[0]?.id).toContain('run-2');
    expect(feed.current().recentEvents).toHaveLength(1);
    for (let seq = 2; seq <= 80; seq++) feed.update(view(seq, 'hand-1', 'run-2'), [action(seq)]);
    expect(feed.current().recentEvents).toHaveLength(32);
    feed.update(view(80, 'hand-1', 'run-2'), [action(1)]);
    expect(feed.current().recentEvents).toHaveLength(32);
  });

  it('ignores events from another table, a future state sequence or private message types', () => {
    const feed = new SpectatorFeed(view());
    feed.update(view(), [
      action(1, { table_id: 'other-table' }),
      action(100),
      action(2, { type: 'your_turn', valid_actions: [{ action: 'raise' }] }),
    ]);
    expect(feed.current().recentEvents).toEqual([]);
    feed.update(view(), [
      action(3, { action_id: 'same-action', contribution_delta: 50 }),
      action(4, { action_id: 'same-action', contribution_delta: 50 }),
      action(5, { action: 'invalid-action', contribution_delta: 99 }),
      action(6, { action: 'fold', contribution_delta: 99 }),
    ]);
    expect(
      feed
        .current()
        .recentEvents.flatMap((event) => event.movements)
        .map((m) => m.amount),
    ).toEqual([50]);
  });

  it('publishes existing evaluations only when every referenced decision belongs to an ended hand', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(
      {
        ...loadConfig({}, true),
        publicHistory: true,
        apiToken: 'spectator-admin-token-32-characters',
      },
      { store },
    );
    try {
      store.db.prepare("UPDATE hands SET status='playing' WHERE id='demo-jev-hand-4'").run();
      for (const [id, decisions] of [
        ['ended', ['demo-jev-hand-1-flop']],
        ['active', ['demo-jev-hand-4-flop']],
        ['mixed', ['demo-jev-hand-1-flop', 'demo-jev-hand-4-flop']],
        ['missing', ['missing-decision']],
      ] as const) {
        app.controller.queries.saveEvaluation({
          id,
          createdAt: new Date().toISOString(),
          sourceRunId: 'demo-jev',
          strategy: 'baseline',
          samples: decisions.length,
          agreements: 0,
          errors: 0,
          costUsd: 0,
          meanLatencyMs: 0,
          rows: decisions.map((decisionId) => ({
            decisionId,
            original: 'fold',
            alternative: 'fold',
            status: 'ok',
          })),
        });
      }
      const result = (await app.inject('/api/evaluations')).json<EvaluationView[]>();
      expect(result.map((evaluation) => evaluation.id)).toEqual(['ended']);
      expect(
        (await app.inject({ method: 'POST', url: '/api/evaluations', payload: {} })).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
      store.close();
    }
  });
});

describe('spectator SSE lifecycle', () => {
  it('streams anonymous snapshots over real HTTP, reconnects with current state and releases subscriptions', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(
      {
        ...loadConfig({}, true),
        apiToken: 'spectator-test-admin-token-32-chars',
        publicHistory: true,
      },
      { store },
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const feed = app.controller.spectator;
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${address}/api/live`, { signal: abort.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-store');
      reader = response.body!.getReader();
      const initial = new TextDecoder().decode((await reader.read()).value);
      expect(initial).toContain('event: snapshot');
      expect(initial).toContain('"heroCards":["Qh","Qs"]');
      expect(feed.subscriberCount).toBe(1);
      feed.update(view(), [action(1, { contribution_delta: 50 })]);
      const next = new TextDecoder().decode((await reader.read()).value);
      const snapshot = JSON.parse(next.split('data: ')[1]!.trim()) as SpectatorSnapshot;
      expect(snapshot.runtime.table?.pot).toBe(300);
      expect(snapshot.recentEvents[0]?.movements[0]?.amount).toBe(50);
      expect(next).not.toMatch(/must-never|private-error|turn_token/);
      await reader.cancel();
      await vi.waitFor(() => expect(feed.subscriberCount).toBe(0));
      const reconnect = await fetch(`${address}/api/live`, { signal: abort.signal });
      reader = reconnect.body!.getReader();
      const reloaded = new TextDecoder().decode((await reader.read()).value);
      expect(reloaded).toContain(snapshot.recentEvents[0]!.id);
      expect(reloaded).toContain('"heroCards":["As","Ad"]');
      await app.close();
      expect(feed.subscriberCount).toBe(0);
    } finally {
      abort.abort();
      await reader?.cancel().catch(() => {});
      await app.close();
      store.close();
    }
  });

  it('disconnects slow consumers immediately and clears heartbeat timers', () => {
    vi.useFakeTimers();
    try {
      class Response extends EventEmitter {
        writeHead = vi.fn();
        write = vi.fn().mockReturnValue(false);
        destroy = vi.fn(() => this.emit('close'));
      }
      const response = new Response();
      const feed = new SpectatorFeed(view());
      openSpectatorStream({ raw: response, hijack() {} } as unknown as FastifyReply, feed);
      expect(response.destroy).toHaveBeenCalledTimes(1);
      expect(feed.subscriberCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a comment heartbeat every 15 seconds and removes it on disconnect', () => {
    vi.useFakeTimers();
    try {
      class Response extends EventEmitter {
        writeHead = vi.fn();
        write = vi.fn().mockReturnValue(true);
        destroy = vi.fn(() => this.emit('close'));
      }
      const response = new Response();
      const feed = new SpectatorFeed(view());
      const close = openSpectatorStream(
        { raw: response, hijack() {} } as unknown as FastifyReply,
        feed,
      );
      expect(response.write).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(15_000);
      expect(response.write).toHaveBeenLastCalledWith(': heartbeat\n\n');
      expect(feed.subscriberCount).toBe(1);
      close();
      expect(feed.subscriberCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes local WebSocket events after the runtime reducer and ignores stale action messages', async () => {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/api/season/me'
            ? { chip_balance: 5000, chips_at_table: 0, pro_tier: false, auto_rebuy: true }
            : { playing: false, table_id: null },
        ),
      );
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', (ws) => {
      const send = (event: Record<string, unknown>) => ws.send(JSON.stringify(event));
      send({ type: 'connected', agent_id: 'mock-hero' });
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'join_lobby') {
          send({
            type: 'table_joined',
            table_id: 'table-1',
            seat: 0,
            players: [{ seat: 0, name: 'Hero', stack: 2000 }],
          });
          send({ type: 'hand_start', table_id: 'table-1', hand_id: 'hand-1', table_seq: 1 });
          send({
            type: 'table_state',
            table_id: 'table-1',
            hand_id: 'hand-1',
            table_seq: 2,
            pot: 0,
            board: [],
            actor_seat: 0,
            hero: { seat: 0, hole_cards: ['As', 'Ad'], turn_token: 'private-turn' },
            seats: [{ seat: 0, name: 'Hero', stack: 2000, in_hand: true }],
          });
          send(action(3, { contribution_delta: 75, pot_after: 75, stack_after: 1925 }));
          send(action(3, { contribution_delta: 75 }));
          send(action(2, { contribution_delta: 999 }));
        } else if (message.type === 'leave_table') send({ type: 'error', code: 'not_at_table' });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const store = new Store(':memory:');
    const app = await buildApp(
      {
        ...loadConfig({}),
        openPokerApiKey: 'mock-openpoker-key',
        openPokerRestUrl: `http://127.0.0.1:${port}`,
        openPokerWsUrl: `ws://127.0.0.1:${port}`,
      },
      { store },
    );
    try {
      await app.controller.start({
        strategy: 'baseline',
        buyIn: 2000,
        maxHands: 0,
        maxMinutes: 0,
        budgetUsd: 0,
        autoRebuy: true,
      });
      await vi.waitFor(() => {
        const snapshot = app.controller.spectator.current();
        expect(snapshot.runtime.table?.pot).toBe(75);
        expect(snapshot.runtime.table?.seats[0]?.stack).toBe(1925);
        expect(snapshot.runtime.table?.heroCards).toEqual(['As', 'Ad']);
        expect(
          snapshot.recentEvents.flatMap((event) => event.movements).map((m) => m.amount),
        ).toEqual([75]);
        expect(JSON.stringify(snapshot)).not.toContain('private-turn');
      });
    } finally {
      await app.close();
      store.close();
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
