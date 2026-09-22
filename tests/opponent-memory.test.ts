import { afterEach, describe, expect, it } from 'vitest';
import { createInitialState } from '../src/core/index.js';
import type { PokerState } from '../src/core/types.js';
import type { ServerEvent } from '../src/openpoker/protocol.js';
import { Store } from '../src/storage/store.js';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  for (const id of ['run', 'replay'])
    store.beginRun({
      id,
      kind: 'live',
      strategy: 'jev',
      startedAt: '2026-01-01T00:00:00.000Z',
      config: {},
    });
  return store;
}
function state(name = 'villain', handId = 'current'): PokerState {
  return {
    ...createInitialState(),
    handId,
    tableId: 'table',
    heroSeat: 0,
    seats: [
      { seat: 0, name: 'hero', stack: 100, bet: 0, status: 'active' },
      { seat: 1, name, stack: 100, bet: 0, status: 'active' },
    ],
  };
}
const day = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
function hand(
  store: Store,
  options: {
    id?: string;
    name?: string;
    seq?: number;
    run?: string;
    completed?: string;
    received?: string;
    shown?: boolean;
    metadata?: boolean;
    changeName?: boolean;
  } = {},
) {
  const id = options.id ?? 'old-hand';
  let seq = options.seq ?? 1;
  const emit = (value: Record<string, unknown>, received = day(1)) =>
    store.appendEvent(
      options.run ?? 'run',
      {
        ...value,
        hand_id: id,
        table_id: 'table',
        table_seq: seq++,
        ts: received,
      } as ServerEvent,
      received,
    );
  const seats = [
    { seat: 0, name: 'hero', stack: 100, bet: 0, status: 'active', in_hand: true },
    {
      seat: 1,
      name: options.name ?? 'villain',
      stack: 100,
      bet: 0,
      status: 'active',
      in_hand: true,
    },
  ];
  emit({
    type: 'table_state',
    hero: { seat: 0, hole_cards: ['As', 'Ah'] },
    seats,
    board: ['2c', '3d', '8h', '9s', 'Qc'],
  });
  if (options.changeName)
    emit({
      type: 'table_state',
      hero: { seat: 0 },
      seats: [{ ...seats[1], name: 'replacement' }],
      board: [],
    });
  const actions = [
    { seat: 1, action: 'raise', amount: 20, street: 'flop' },
    { seat: 0, action: 'call', amount: null, street: 'flop' },
    { seat: 1, action: 'check', amount: null, street: 'turn' },
    { seat: 0, action: 'raise', amount: 30, street: 'turn' },
    { seat: 1, action: 'fold', amount: null, street: 'turn' },
  ];
  if (options.metadata !== false)
    for (const [index, action] of actions.entries())
      emit({
        ...action,
        type: 'player_action',
        // The last action's server-reported street is wrong; result.actions is authoritative here.
        street: index === 4 ? 'river' : action.street,
        to_call_before: index === 1 ? 20 : index === 4 ? 30 : null,
        contribution_delta:
          action.action === 'raise' ? action.amount : action.action === 'call' ? 20 : 0,
        pot_before: 100,
      });
  emit(
    {
      type: 'hand_result',
      actions,
      shown_cards: options.shown === false ? {} : { '1': ['Kd', 'Kh'] },
      ts: options.completed ?? day(2),
    },
    options.received ?? options.completed ?? day(2),
  );
  // emit uses the receive timestamp for ts: set an explicit potentially different completed time.
  if (options.completed && options.received)
    store.db
      .prepare(
        "UPDATE events SET payload=json_set(payload,'$.ts',?) WHERE run_id=? AND hand_id=? AND type='hand_result'",
      )
      .run(options.completed, options.run ?? 'run', id);
}

describe('bounded completed opponent memory', () => {
  it('backfills existing completed hands and preserves public evidence with street-specific denominators', () => {
    const store = fixture();
    hand(store);
    const [memory] = store.getOpponentMemory(state(), day(3));
    expect(memory).toMatchObject({
      name: 'villain',
      sampledHands: 1,
      shownHands: 1,
      sampleCapped: false,
    });
    expect(memory?.streets.flop).toMatchObject({
      observedActions: 1,
      raises: 1,
      facedBetObserved: 0,
      sizedContributions: 1,
      contributionToPotSum: 0.2,
    });
    expect(memory?.streets.turn).toMatchObject({
      observedActions: 2,
      checks: 1,
      folds: 1,
      facedBetObserved: 1,
      foldedToObservedBet: 1,
    });
    expect(memory?.streets.river.observedActions).toBe(0);
    expect(memory?.showdowns[0]).toMatchObject({
      handId: 'old-hand',
      tableId: 'table',
      shownCards: ['Kd', 'Kh'],
      board: ['2c', '3d', '8h', '9s', 'Qc'],
      heroParticipated: true,
    });
    expect(memory?.showdowns[0]?.resultEventId).toBeGreaterThan(0);
    expect(JSON.stringify(memory)).not.toContain('As');
    expect(store.db.prepare('SELECT count(*) n FROM events').get()?.n).toBe(7);
  });
  it('requires completion and receipt strictly before the cutoff and excludes the current hand', () => {
    const store = fixture();
    hand(store, { id: 'late-receipt', completed: day(2), received: day(4) });
    hand(store, { id: 'future-complete', seq: 100, completed: day(4), received: day(2) });
    hand(store, { id: 'current', seq: 200, completed: day(2) });
    expect(store.getOpponentMemory(state(), day(3))).toEqual([]);
    expect(store.getOpponentMemory(state('villain', 'other'), day(2))).toEqual([]);
    const [after] = store.getOpponentMemory(state('villain', 'other'), day(5));
    expect(after?.sampledHands).toBe(3);
    // Materializing with a later cutoff must not leak future memory on a historical query.
    expect(store.getOpponentMemory(state(), day(3))).toEqual([]);
  });
  it('uses same-hand seat identity, excludes ambiguous seat replacements and only retrieves current names', () => {
    const store = fixture();
    hand(store, { id: 'first', name: 'first-name' });
    hand(store, { id: 'second', seq: 100, name: 'second-name' });
    hand(store, { id: 'ambiguous', seq: 200, name: 'first-name', changeName: true });
    expect(store.getOpponentMemory(state('first-name'), day(3))[0]?.sampledHands).toBe(1);
    expect(store.getOpponentMemory(state('second-name'), day(3))[0]?.showdowns[0]?.handId).toBe(
      'second',
    );
    expect(store.getOpponentMemory(state('unknown'), day(3))).toEqual([]);
  });
  it('deduplicates replay across runs and repeated queries while indexing new hands incrementally', () => {
    const store = fixture();
    hand(store);
    expect(store.getOpponentMemory(state(), day(3))[0]?.sampledHands).toBe(1);
    hand(store, { run: 'replay' });
    expect(store.getOpponentMemory(state(), day(3))[0]?.sampledHands).toBe(1);
    hand(store, { id: 'new', seq: 100 });
    expect(store.getOpponentMemory(state(), day(3))[0]?.sampledHands).toBe(2);
    expect(store.getOpponentMemory(state(), day(3))[0]?.streets.turn.facedBetObserved).toBe(2);
  });
  it('does not fabricate facing-bet or sizing evidence when action metadata is missing', () => {
    const store = fixture();
    hand(store, { metadata: false, shown: false });
    const [memory] = store.getOpponentMemory(state(), day(3));
    expect(memory?.streets.turn).toMatchObject({
      checks: 1,
      folds: 1,
      facedBetObserved: 0,
      foldedToObservedBet: 0,
    });
    expect(memory?.streets.flop.sizedContributions).toBe(0);
    expect(memory?.shownHands).toBe(0);
    expect(memory?.showdowns).toEqual([]);
  });
  it('does not match later repeated actions to missing earlier event metadata', () => {
    const store = fixture();
    hand(store);
    store.db.prepare("DELETE FROM events WHERE type='player_action' AND seq=2").run();
    const [memory] = store.getOpponentMemory(state(), day(3));
    expect(memory?.streets.flop.raises).toBe(1);
    expect(memory?.streets.flop.sizedContributions).toBe(0);
    expect(memory?.streets.turn.facedBetObserved).toBe(0);
  });
  it('rejects identity or card evidence received after the hand result', () => {
    const store = fixture();
    hand(store);
    store.db.prepare("UPDATE events SET received_at=? WHERE type='table_state'").run(day(4));
    expect(store.getOpponentMemory(state(), day(5))).toEqual([]);
  });
  it('caps the historical sample and representative examples without truncating raw data', () => {
    const store = fixture();
    for (let i = 0; i < 205; i++)
      hand(store, { id: `hand-${i}`, seq: i * 10 + 1, metadata: false });
    const [memory] = store.getOpponentMemory(state(), day(3));
    expect(memory).toMatchObject({
      sampledHands: 200,
      sampleLimit: 200,
      sampleCapped: true,
      shownHands: 200,
    });
    expect(memory?.showdowns).toHaveLength(3);
    expect(memory?.recentEncountersWithHero).toHaveLength(3);
    expect(store.db.prepare('SELECT count(*) n FROM opponent_encounters').get()?.n).toBe(205);
    expect(store.db.prepare('SELECT count(*) n FROM events').get()?.n).toBe(410);
  });
});
