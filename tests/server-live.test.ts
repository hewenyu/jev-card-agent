import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';
import type { Overview, RunSummary } from '../src/shared/api.js';

it('starts the autonomous runtime through the control API and exposes its confirmed result through SQLite queries', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/season/me') {
      response.end(
        JSON.stringify({
          chip_balance: 5000,
          chips_at_table: 0,
          pro_tier: false,
          auto_rebuy: true,
        }),
      );
      return;
    }
    response.end(JSON.stringify({ playing: false, table_id: null, seat: null, stack_chips: null }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (ws) => {
    const send = (event: Record<string, unknown>) => ws.send(JSON.stringify(event));
    send({ type: 'connected', agent_id: 'mock-hero', name: 'Hero' });
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === 'join_lobby') {
        send({
          type: 'table_joined',
          table_id: 'table1',
          seat: 0,
          players: [{ seat: 0, name: 'Hero', stack: 2000 }],
        });
        send({ type: 'hand_start', table_id: 'table1', hand_id: 'hand1', table_seq: 1, seat: 0 });
        send({
          type: 'your_turn',
          table_id: 'table1',
          hand_id: 'hand1',
          table_seq: 2,
          turn_token: 'private-test-token',
          valid_actions: [{ action: 'check' }],
        });
      } else if (event.type === 'action') {
        send({
          type: 'action_ack',
          client_action_id: event.client_action_id,
          status: 'accepted',
          hand_id: 'hand1',
        });
        send({
          type: 'hand_result',
          table_id: 'table1',
          hand_id: 'hand1',
          table_seq: 5,
          final_stacks: { '0': 2020 },
        });
      } else if (event.type === 'leave_table') send({ type: 'error', code: 'not_at_table' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const store = new Store(':memory:');
  store.beginRun({
    id: 'abandoned-run',
    kind: 'live',
    strategy: 'jev',
    startedAt: '2026-01-01T00:00:00Z',
    config: {},
  });
  const app = await buildApp(
    {
      ...loadConfig({}),
      staticRoot: '/no-static-test',
      openPokerApiKey: 'mock-key',
      openPokerWsUrl: `ws://127.0.0.1:${port}`,
      openPokerRestUrl: `http://127.0.0.1:${port}`,
    },
    { store },
  );
  try {
    const start = await app.inject({
      method: 'POST',
      url: '/api/runtime/start',
      payload: { strategy: 'baseline', maxHands: 1 },
    });
    expect(start.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const overview = (await app.inject('/api/overview')).json<Overview>();
      expect(overview.runtime.status).toBe('stopped');
      expect(overview.metrics.hands).toBe(1);
      expect(overview.metrics.netChips).toBe(20);
    });
    const runs = (await app.inject('/api/runs')).json<RunSummary[]>();
    expect(runs.find((run) => run.id === 'abandoned-run')?.status).toBe('interrupted');
    expect(runs[0]?.decisions).toBe(1);
    expect(runs[0]?.status).toBe('stopped');
    const detail = await app.inject('/api/hands/hand1');
    expect(detail.body).not.toContain('private-test-token');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM leases').get()?.n).toBe(0);
  } finally {
    await app.close();
    store.close();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
