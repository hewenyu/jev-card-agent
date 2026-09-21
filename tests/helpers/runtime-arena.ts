import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { PokerRuntime } from '../../src/runtime/runtime.js';
import { BaselinePolicy } from '../../src/policies/baseline.js';
import type { Policy } from '../../src/core/types.js';
import type {
  DecisionRecord,
  RuntimeCheckpoint,
  RuntimeStore,
  StoredAction,
} from '../../src/runtime/types.js';

export class MemoryStore implements RuntimeStore {
  assertRuntimeLease() {}
  actions = new Map<string, StoredAction>();
  decisions: DecisionRecord[] = [];
  blocks: import('../../src/runtime/types.js').DecisionBlock[] = [];
  saveDecisionBlock(value: import('../../src/runtime/types.js').DecisionBlock) {
    this.blocks.push(value);
  }
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
export async function arena(
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
export function send(ws: WebSocket, value: Record<string, unknown>) {
  ws.send(JSON.stringify(value));
}
export function joined(ws: WebSocket) {
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
export function turn(ws: WebSocket, hand: number, sequence = hand * 100) {
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
export function resync(ws: WebSocket, hand: string, token: string, sequence = 110) {
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
export function createRuntime(
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
