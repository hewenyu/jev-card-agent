import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { seedDemo } from '../src/storage/demo.js';
import { Queries } from '../src/storage/queries.js';
import { Budget } from '../src/storage/budget.js';
import { evaluateRun } from '../src/evaluation/service.js';
import { buildCandidates, buildContext, createInitialState } from '../src/core/index.js';
import { redact } from '../src/storage/database.js';
import type { PokerState } from '../src/core/types.js';

const stores: Store[] = [];
function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  seedDemo(store);
  return { store, queries: new Queries(store) };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('persistent decision evidence', () => {
  it('seeds deterministic labelled runs, joins decisions to hands, and does not duplicate seed', () => {
    const { store, queries } = fixture();
    seedDemo(store);
    expect(queries.runs()).toHaveLength(2);
    expect(queries.hands()).toHaveLength(8);
    expect(queries.runs().find((run) => run.id === 'demo-jev')).toMatchObject({
      mode: 'demo',
      hands: 4,
      decisions: 8,
      netChips: 400,
    });
    const detail = queries.hand('demo-jev-hand-1')!;
    expect(detail.decisions).toHaveLength(2);
    expect(detail.decisions.every((d) => d.status === 'accepted')).toBe(true);
    expect(detail.events.some((event) => event.type === 'hand_result')).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('synthetic-demo');
    expect(queries.metrics('live').hands).toBe(0);
  });
  it('protects action payload identity and preserves terminal confirmation', () => {
    const { store } = fixture();
    const row = store.db.prepare('SELECT * FROM actions LIMIT 1').get()!;
    const action = {
      id: String(row.id),
      runId: String(row.run_id),
      decisionId: String(row.decision_id),
      tableId: String(row.table_id),
      payload: JSON.parse(String(row.payload)),
      status: 'prepared' as const,
      createdAt: String(row.created_at),
      deadlineAt: Number(row.deadline_at),
    };
    expect(() =>
      store.prepareAction({ ...action, payload: { ...action.payload, action: 'fold' } }),
    ).toThrow('conflict');
    store.updateAction(action.id, 'unresolved');
    expect(store.pendingActions()).toHaveLength(0);
    expect(store.db.prepare('SELECT status FROM actions WHERE id=?').get(action.id)?.status).toBe(
      'accepted',
    );
  });
  it('does not award a counterfactual payoff to replayed baseline decisions', async () => {
    const { store, queries } = fixture();
    const before = queries.runs();
    const result = await evaluateRun(store, 'demo-jev', 'baseline', 4);
    expect(result.samples).toBe(4);
    expect(result.errors).toBe(0);
    expect(result.rows.every((row) => row.alternative)).toBe(true);
    expect(result).not.toHaveProperty('profit');
    expect(queries.runs()).toEqual(before);
    expect(queries.evaluations()).toHaveLength(1);
  });
  it('strips credentials recursively from exported records', () => {
    expect(
      redact({
        turn_token: 'private',
        hero: { hole_cards: ['Ah', 'Kd'] },
        nested: { api_key: 'secret', Authorization: 'private', pot: 20 },
      }),
    ).toEqual({ hero: { hole_cards: ['Ah', 'Kd'] }, nested: { pot: 20 } });
  });
  it('preserves a resync envelope and its replay event at the same watermark', () => {
    const { store } = fixture();
    const event = {
      type: 'resync_response',
      table_id: 'resync-table',
      table_seq: 100,
      hand_id: 'resync-hand',
    };
    store.appendEvent('demo-jev', event, new Date().toISOString());
    store.appendEvent('demo-jev', { ...event, type: 'hand_result' }, new Date().toISOString());
    store.appendEvent('demo-jev', { ...event, type: 'hand_result' }, new Date().toISOString());
    const rows = store.db
      .prepare("SELECT type,payload FROM events WHERE table_id='resync-table'")
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.type)).toEqual(['resync_response', 'hand_result']);
    expect(rows.every((row) => JSON.parse(String(row.payload)).table_seq === 100)).toBe(true);
  });
});

describe('budget accounting', () => {
  const state: PokerState = {
    ...createInitialState(),
    tableId: 'table',
    handId: 'hand',
    heroSeat: 0,
    turnToken: 'test-turn',
    validActions: [{ action: 'check' }],
    seats: [],
    complete: false,
  };
  const context = buildContext(state),
    candidates = buildCandidates(state);
  it('counts in-flight and unknown usage against the cap', () => {
    const { store } = fixture();
    const budget = new Budget(store, 0.004, 0.004);
    const id = budget.reserve('run', context, candidates)!;
    expect(id).toBeTruthy();
    expect(budget.reserve('run', context, candidates)).toBeNull();
    budget.settle(id, null);
    expect(budget.summary().unknownRequests).toBe(1);
    expect(budget.reserve('run', context, candidates)).toBeNull();
  });
  it('reconciles actual usage once and prevents an oversized payload', () => {
    const { store } = fixture();
    const budget = new Budget(store, 0.004, 0.004);
    const id = budget.reserve('run', context, candidates)!;
    const proposal = {
      candidateId: 'check',
      selected: 'check',
      source: 'jev' as const,
      explanation: 'test',
      latencyMs: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
    };
    budget.settle(id, proposal);
    budget.settle(id, { ...proposal, usage: { input_tokens: 9000, output_tokens: 10 } });
    expect(budget.summary().estimatedUsd).toBeCloseTo(0.000042, 9);
    expect(budget.reserve('run', context, candidates)).not.toBeNull();
    expect(
      budget.reserve('another', { ...context, version: 'x'.repeat(49_000) }, candidates),
    ).toBeNull();
  });
});
