import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { PokerRuntime } from './helpers/policy-runtime.js';
import { BaselinePolicy } from '../src/policies/baseline.js';
import { parseEvent, verifyStateHash, type ServerEvent } from '../src/openpoker/protocol.js';
import { Store } from '../src/storage/store.js';

const wire = readFileSync(
  new URL('./fixtures/openpoker-python-floats.json.txt', import.meta.url),
  'utf8',
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function recoveringRuntime(snapshotWire: string) {
  const messages: string[] = [];
  const http = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ playing: true, table_id: 'test-table', seat: 0, stack_chips: 2000 }),
    );
  });
  const arena = new WebSocketServer({ server: http });
  arena.on('connection', (socket) => {
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      messages.push(message.type);
      if (message.type === 'resync_request') socket.send(snapshotWire);
      if (message.type === 'leave_table') socket.send('{"type":"error","code":"not_at_table"}');
    });
    socket.send('{"type":"connected"}');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const store = new Store(':memory:');
  expect(store.acquireLease()).toBe(true);
  const runtime = new PokerRuntime({
    apiKey: 'synthetic-local-test',
    wsUrl: `ws://127.0.0.1:${port}`,
    restUrl: `http://127.0.0.1:${port}`,
    policy: new BaselinePolicy(),
    store,
  });
  cleanups.push(async () => {
    runtime.stop(false);
    await vi.waitFor(() => expect(['stopped', 'failed']).toContain(runtime.status().phase), {
      interval: 10,
    });
    for (const socket of arena.clients) socket.terminate();
    await new Promise<void>((resolve) => arena.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    store.close();
  });
  await runtime.start({ runId: 'hash-regression', strategy: 'baseline' });
  return { runtime, store, messages };
}

describe('resync hash verification on the runtime WebSocket path', () => {
  it('accepts the Python-float waiting snapshot, persists verifiable evidence and leaves normally', async () => {
    const { runtime, store, messages } = await recoveringRuntime(wire);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('playing'), { interval: 10 });
    expect(runtime.status().lastError).toBeNull();
    expect(runtime.state.waitingReason).toBe('between_hands_delay');
    expect(runtime.state.lastTableSeq).toBe(200);
    expect(messages.filter((message) => message === 'resync_request')).toHaveLength(1);
    const rows = store.db
      .prepare("SELECT payload FROM events WHERE type IN ('resync_response','table_state')")
      .all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const event = parseEvent(String(row.payload));
      expect(verifyStateHash(event)).toBe(true);
      if (event.snapshot) expect(verifyStateHash(event.snapshot as ServerEvent)).toBe(true);
    }
    runtime.stop();
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'), { interval: 10 });
    expect(messages).toContain('leave_table');
    expect(messages).not.toContain('action');
  });

  it('still refuses a snapshot whose nested numeric value no longer matches the hash', async () => {
    const { runtime, store, messages } = await recoveringRuntime(
      wire.replaceAll('"configured_delay_seconds": 5.0', '"configured_delay_seconds": 6.0'),
    );
    await vi.waitFor(() => expect(runtime.status().phase).toBe('failed'), { interval: 10 });
    expect(runtime.status().lastError).toBe('Resync snapshot hash mismatch');
    expect(runtime.state.lastTableSeq).toBe(-1);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM decisions').get()?.n).toBe(0);
    expect(messages).not.toContain('action');
  });
});
