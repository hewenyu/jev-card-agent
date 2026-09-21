import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialState } from '../src/core/index.js';
import type { PokerState, Proposal, ProviderAttempt, ProviderCall } from '../src/core/types.js';
import { Budget } from '../src/storage/budget.js';
import { proposalCost } from '../src/storage/cost.js';
import { LedgerMeter } from '../src/storage/provider-meter.js';
import { Queries } from '../src/storage/queries.js';
import { Store } from '../src/storage/store.js';
import { evaluateRun } from '../src/evaluation/service.js';
import { seedDemo } from '../src/storage/demo.js';

const stores: Store[] = [];
const directories: string[] = [];
const makeStore = (path = ':memory:') => {
  const store = new Store(path);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const call: ProviderCall = {
  provider: 'messages',
  purpose: 'analysis',
  requestedModel: 'claude-test',
  inputCharacters: 1000,
  maxOutputTokens: 500,
};
const attempt = (id: string, overrides: Partial<ProviderAttempt> = {}): ProviderAttempt => ({
  id,
  provider: call.provider,
  purpose: call.purpose,
  requestedModel: call.requestedModel,
  actualModel: call.requestedModel,
  status: 'succeeded',
  usage: { input_tokens: 1000, output_tokens: 100 },
  latencyMs: 500,
  ...overrides,
});
const proposal = (attempts: ProviderAttempt[]): Proposal => ({
  candidateId: 'check',
  selected: 'check',
  source: 'jev',
  explanation: 'test',
  latencyMs: 500,
  attempts,
});

describe('provider cost ledger', () => {
  it('includes previously reserved provider calls when an evaluation is cancelled without a proposal', async () => {
    const store = makeStore();
    seedDemo(store);
    const meter = new LedgerMeter(store, 'evaluation-cancelled-eval');
    const policy = {
      decide: async () => {
        const id = meter.before(call)!;
        meter.after(attempt('cancelled-evaluation', { status: 'cancelled', usage: null }), id);
        throw new DOMException('Timed out', 'TimeoutError');
      },
    };
    const result = await evaluateRun(store, 'demo-jev', 'jev-reasoning', 1, policy, undefined, {
      id: 'cancelled-eval',
    });
    expect(result.errors).toBe(1);
    expect(result.costUsd).toBe(new Budget(store).summary().reservedUsd);
    expect(result.costUsd).toBeGreaterThan(0);
  });
  it('charges each provider at its configured rate even on model mismatch and settles only once', () => {
    const store = makeStore();
    const meter = new LedgerMeter(store, 'run', {
      totalUsd: 1,
      runUsd: 1,
      reasoningInputPerMillion: 2,
      reasoningOutputPerMillion: 8,
    });
    const id = meter.before(call)!;
    const failed = attempt('mismatch', { status: 'model_mismatch', actualModel: 'another-model' });
    meter.after(failed, id);
    meter.after(attempt('retry', { usage: { input_tokens: 9000, output_tokens: 9000 } }), id);
    const jevId = meter.before({ ...call, provider: 'jev', purpose: 'reconsider' })!;
    const jev = attempt('jev', { provider: 'jev', purpose: 'reconsider' });
    meter.after(jev, jevId);
    expect(new Budget(store).summary().estimatedUsd).toBeCloseTo(0.002842, 9);
    expect(proposalCost(store, proposal([failed, jev]))).toBeCloseTo(0.002842, 9);
    expect(
      store.db.prepare('SELECT status FROM provider_usage WHERE attempt_id=?').get('mismatch')
        ?.status,
    ).toBe('model_mismatch');
  });

  it('keeps cancelled requests with unknown usage reserved across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-meter-'));
    directories.push(directory);
    const path = join(directory, 'test.sqlite');
    const first = makeStore(path);
    const meter = new LedgerMeter(first, 'run', { totalUsd: 0.3, runUsd: 0.3 });
    const id = meter.before(call)!;
    expect(id).toBeTruthy();
    const cancelled = attempt('cancelled', { status: 'cancelled', usage: null });
    meter.after(cancelled, id);
    const reserved = new Budget(first).summary().reservedUsd;
    expect(reserved).toBeGreaterThan(0.2);
    expect(proposalCost(first, proposal([cancelled]))).toBe(reserved);
    const second = makeStore(path);
    expect(new LedgerMeter(second, 'run', { totalUsd: 0.3, runUsd: 0.3 }).before(call)).toBeNull();
    expect(new Budget(second).summary().unknownRequests).toBe(1);
  });
});

describe('settlement integrity and process recovery', () => {
  it('does not attribute a hand spanning two strategy runs to either strategy profit', () => {
    const store = makeStore();
    for (const id of ['before-restart', 'after-restart'])
      store.beginRun({
        id,
        kind: 'live',
        strategy: id === 'before-restart' ? 'jev' : 'baseline',
        startedAt: new Date().toISOString(),
        config: {},
      });
    const state = {
      ...createInitialState(),
      tableId: 'table',
      handId: 'spanning-hand',
      heroSeat: 0,
      handStartStacks: { '0': 2000 },
    };
    store.saveHand('before-restart', state, { type: 'hand_start' });
    store.saveHand('after-restart', state, { type: 'hand_result', final_stacks: { '0': 3000 } });
    expect(new Queries(store).hand('spanning-hand')!.hand).toMatchObject({
      complete: false,
      profit: null,
    });
    expect(new Queries(store).metrics('live').hands).toBe(0);
  });
  it('excludes missing-start hands and separates later rebuy stacks from settled profit', () => {
    const store = makeStore();
    store.beginRun({
      id: 'run',
      kind: 'live',
      strategy: 'baseline',
      startedAt: new Date().toISOString(),
      config: {},
    });
    const state: PokerState = {
      ...createInitialState(),
      tableId: 'table',
      handId: 'complete-hand',
      heroSeat: 0,
      handStartStacks: { '0': 2000 },
      seats: [{ seat: 0, name: 'hero', stack: 1800, bet: 0, status: 'active' }],
    };
    store.saveHand('run', state, { type: 'hand_start' });
    store.saveHand('run', state, { type: 'hand_result', final_stacks: { '0': 1800 } });
    store.saveHand(
      'run',
      { ...state, seats: [{ ...state.seats[0]!, stack: 5000 }] },
      { type: 'table_state' },
    );
    // A partial historical replay must not erase an already reconciled result.
    store.saveHand(
      'run',
      { ...state, historyIncomplete: true, handStartStacks: {} },
      { type: 'hand_result', final_stacks: {} },
    );
    store.saveHand(
      'run',
      { ...state, handId: 'partial-hand', historyIncomplete: true, handStartStacks: {} },
      { type: 'hand_result', final_stacks: { '0': 5000 } },
    );
    store.saveHand('run', { ...state, handId: 'missing-result' }, { type: 'hand_result' });
    const queries = new Queries(store);
    expect(queries.metrics('live')).toMatchObject({ hands: 1, netChips: -200, bb100: -1000 });
    expect(queries.hand('partial-hand')!.hand).toMatchObject({ profit: null, complete: false });
    expect(queries.hand('missing-result')!.hand).toMatchObject({ profit: null, complete: false });
    expect(queries.runs()[0]).toMatchObject({
      hands: 3,
      settledHands: 1,
      excludedHands: 2,
      model: 'heuristic-v1',
    });
  });

  it('persists checkpoints and prevents another store from taking an active lease', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-recovery-'));
    directories.push(directory);
    const path = join(directory, 'test.sqlite');
    const first = makeStore(path),
      second = makeStore(path);
    expect(first.acquireLease()).toBe(true);
    expect(second.acquireLease()).toBe(false);
    second.releaseLease();
    expect(second.acquireLease()).toBe(false);
    const checkpoint = {
      tableId: 'table',
      lastTableSeq: 91,
      state: { ...createInitialState(), tableId: 'table', lastTableSeq: 91 },
    };
    first.saveCheckpoint(checkpoint);
    expect(second.loadCheckpoint()).toEqual(checkpoint);
    first.releaseLease();
    expect(second.acquireLease()).toBe(true);
    expect(first.acquireLease()).toBe(false);
    expect(() => first.assertRuntimeLease()).toThrow('lease');
    expect(() => second.assertRuntimeLease()).not.toThrow();
  });
  it('keeps already observed cards when a later recovery contains a sparse snapshot', () => {
    const store = makeStore();
    seedDemo(store);
    store.saveHand(
      'demo-jev',
      {
        ...createInitialState(),
        tableId: 'demo-table-jev',
        handId: 'demo-jev-hand-1',
        historyIncomplete: true,
      },
      { type: 'resync_response' },
    );
    expect(new Queries(store).hand('demo-jev-hand-1')!.hand).toMatchObject({
      board: ['As', '7d', '2c', 'Tc', '4h'],
      heroCards: ['Ah', 'Kd'],
      complete: true,
      profit: 140,
    });
  });
});
