import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildContext, createInitialState } from '../src/core/index.js';
import { Store } from '../src/storage/store.js';
import { rebuildOpponentCheckpoint } from '../src/storage/opponent-rebuild.js';
import type { ServerEvent } from '../src/openpoker/protocol.js';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const players = [
  { seat: 0, name: 'opponent', stack: 100, bet: 0, status: 'active' },
  { seat: 1, name: 'hero', stack: 100, bet: 0, status: 'active' },
];
function fixture(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  for (const [id, kind] of [
    ['live', 'live'],
    ['reconnected', 'live'],
    ['demo', 'demo'],
  ] as const)
    store.beginRun({
      id,
      kind,
      strategy: 'jev',
      startedAt: '2026-01-01T00:00:00.000Z',
      config: {},
    });
  store.saveCheckpoint({ tableId: null, lastTableSeq: -1, state: createInitialState() });
  store.appendEvent(
    'live',
    { type: 'table_joined', table_id: 'table', seat: 1, players },
    '2026-01-02',
  );
  return store;
}
function hand(handId: string, base: number): ServerEvent[] {
  return [
    { type: 'hand_start', table_id: 'table', hand_id: handId, table_seq: base, seat: 1 },
    {
      type: 'table_state',
      table_id: 'table',
      hand_id: handId,
      table_seq: base + 1,
      street: 'preflop',
      actor_seat: 0,
      seats: players,
    },
    {
      type: 'player_action',
      table_id: 'table',
      hand_id: handId,
      table_seq: base + 2,
      seat: 0,
      name: 'opponent',
      action: 'call',
      street: 'flop',
      to_call_before: 20,
      action_id: `action-${handId}`,
    },
  ];
}
function originalHash(store: Store): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        events: store.db.prepare('SELECT * FROM events ORDER BY id').all(),
        decisions: store.db.prepare('SELECT * FROM decisions ORDER BY id').all(),
      }),
    )
    .digest('hex');
}

describe('explicit derived opponent checkpoint rebuild', () => {
  it('rebuilds from receipt order, corrects streets, deduplicates reconnects and excludes demo data', () => {
    const store = fixture();
    const first = hand('first', 1);
    for (const e of first) store.appendEvent('live', e, '2026-01-01');
    for (const e of first) store.appendEvent('reconnected', e, '2026-01-03');
    const second = hand('second', 4);
    store.appendEvent(
      'reconnected',
      {
        type: 'resync_response',
        table_id: 'table',
        to_table_seq: 7,
        replayed_events: [...first, ...second],
        snapshot: { table_id: 'table', hand_id: 'second', street: 'flop', seats: players },
      },
      '2026-01-04',
    );
    for (const e of hand('demo', 10)) store.appendEvent('demo', e, '2026-01-05');
    store.saveDecision({
      id: 'frozen-decision',
      runId: 'live',
      handId: 'first',
      createdAt: '2026-01-01',
      context: buildContext({ ...createInitialState(), handId: 'first' }),
      candidates: [{ id: 'check', action: 'check', label: 'check' }],
      proposal: {
        candidateId: 'check',
        selected: 'check',
        source: 'jev',
        explanation: 'saved',
        latencyMs: 1,
      },
      fallbackReason: null,
    });
    const before = originalHash(store);
    const stateBefore = store.loadCheckpoint()!.state;
    const result = rebuildOpponentCheckpoint(store);
    expect(result).toMatchObject({ eventCount: 8, opponentCount: 1, reused: false });
    expect(store.loadCheckpoint()!.opponents!.stats).toEqual([
      { name: 'opponent', hands: 2, vpip: 2, pfr: 0, facedBet: 2, foldedToBet: 0, lastTableSeq: 6 },
    ]);
    expect(store.loadCheckpoint()!.state).toEqual(stateBefore);
    expect(originalHash(store)).toBe(before);
    expect(rebuildOpponentCheckpoint(store)).toEqual({ ...result, reused: true });
    expect(originalHash(store)).toBe(before);
  });

  it('refuses to rebuild while a hand or runtime lease is active and leaves the checkpoint unchanged', () => {
    const store = fixture();
    store.acquireLease();
    const before = store.loadCheckpoint();
    expect(() => rebuildOpponentCheckpoint(store)).toThrow('Stop the runtime');
    expect(store.loadCheckpoint()).toEqual(before);
    store.releaseLease();
    store.saveCheckpoint({
      ...before!,
      state: { ...before!.state, handId: 'unfinished', complete: false },
    });
    expect(() => rebuildOpponentCheckpoint(store)).toThrow('Finish the current hand');
    expect(store.loadCheckpoint()!.state.handId).toBe('unfinished');
  });
});
