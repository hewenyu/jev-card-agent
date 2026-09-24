import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContext,
  createInitialState,
  STRATEGY_VERSIONS,
  summarizeRecentOutcomes,
} from '../src/core/index.js';
import type { Candidate, DecisionContext, PokerState } from '../src/core/types.js';
import { authorityKey, decide } from '../src/evaluation/legacy/decision.js';
import type { ActionStatus, DecisionRecord } from '../src/runtime/types.js';
import { Store } from '../src/storage/store.js';

const stores: Store[] = [];
const timestamp = (seconds: number) => new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString();
const candidates: Candidate[] = [
  { id: 'check', action: 'check', label: 'Check' },
  { id: 'raise-120', action: 'raise', amount: 120, label: 'Raise to 120' },
];

function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  for (const [id, kind] of [
    ['live', 'live'],
    ['other', 'live'],
    ['demo', 'demo'],
  ] as const) {
    store.beginRun({ id, kind, strategy: 'jev', startedAt: timestamp(0), config: {} });
  }
  return store;
}

function state(handId: string): PokerState {
  return {
    ...createInitialState(),
    tableId: 'table',
    handId,
    heroSeat: 0,
    actorSeat: 0,
    turnToken: 'test-turn',
    lastTableSeq: 22,
    street: 'flop',
    board: ['2h', '3d', '4s'],
    holeCards: ['Ah', 'Kd'],
    handStartStacks: { '0': 1000 },
    validActions: [{ action: 'check' }, { action: 'raise', min: 40, max: 400 }],
  };
}

function settle(
  store: Store,
  handId = 'past',
  options: { runId?: string; ended?: number; incomplete?: boolean } = {},
) {
  store.saveHand(
    options.runId ?? 'live',
    {
      ...state(handId),
      board: ['2h', '3d', '4s', '5c', '6h'],
      historyIncomplete: options.incomplete ?? false,
      complete: true,
    },
    {
      type: 'hand_result',
      final_stacks: { '0': 1120 },
      ts: timestamp(options.ended ?? 20),
      shown_cards: { '1': ['Qc', 'Qd'] },
    },
  );
}

function recordDecision(
  store: Store,
  id: string,
  options: {
    handId?: string;
    runId?: string;
    at?: number;
    seq?: number;
    legacy?: boolean;
    status?: ActionStatus | 'proposed';
    raise?: boolean;
  } = {},
) {
  const handId = options.handId ?? 'past';
  const runId = options.runId ?? 'live';
  const selected = candidates[options.raise ? 1 : 0]!;
  const decision: DecisionRecord = {
    id,
    runId,
    handId,
    createdAt: timestamp(options.at ?? 10),
    context: buildContext({ ...state(handId), lastTableSeq: options.seq ?? 22 }),
    candidates,
    proposal: {
      candidateId: selected.id,
      selected: selected.id,
      source: 'jev',
      explanation: 'Synthetic test decision',
      latencyMs: 1,
    },
    fallbackReason: null,
  };
  store.saveDecision(decision);
  if (options.legacy) {
    store.db
      .prepare("UPDATE decisions SET context=json_remove(context,'$.lastTableSeq') WHERE id=?")
      .run(id);
  }
  if (options.status !== 'proposed') {
    store.prepareAction({
      id: `action-${id}`,
      runId,
      decisionId: id,
      tableId: 'table',
      status: 'prepared',
      createdAt: decision.createdAt,
      deadlineAt: Date.parse(decision.createdAt) + 5000,
      payload: {
        type: 'action',
        action: selected.action,
        ...(selected.amount === undefined ? {} : { amount: selected.amount }),
        hand_id: handId,
        turn_token: 'test-turn',
        client_action_id: `action-${id}`,
      },
    });
    store.updateAction(`action-${id}`, options.status ?? 'accepted');
  }
  return decision;
}

function turn(
  store: Store,
  options: { runId?: string; handId?: string; at?: number; seq?: number; type?: string } = {},
) {
  store.appendEvent(
    options.runId ?? 'live',
    {
      type: options.type ?? 'your_turn',
      table_id: 'table',
      hand_id: options.handId ?? 'past',
      ...(options.seq === undefined ? {} : { table_seq: options.seq }),
    },
    timestamp(options.at ?? 9),
  );
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
});

describe('persisted historical feedback', () => {
  it('excludes demo, current, incomplete, unverified, future and equal-cutoff outcomes before limiting', () => {
    const store = fixture();
    settle(store);
    settle(store, 'demo-hand', { runId: 'demo' });
    settle(store, 'current');
    settle(store, 'unverified', { incomplete: true });
    store.saveHand('live', state('unfinished'), { type: 'your_turn', ts: timestamp(15) });
    settle(store, 'future', { ended: 31 });
    for (let index = 0; index < 10; index++) settle(store, `equal-${index}`, { ended: 30 });
    expect(store.recentOutcomes(timestamp(30), 'current')).toEqual([
      expect.objectContaining({ handId: 'past', verified: true, profitBb: 6 }),
    ]);
  });

  it('uses only accepted actions and freezes decision cards instead of settlement cards', () => {
    const store = fixture();
    settle(store);
    recordDecision(store, 'accepted', { raise: true });
    for (const status of ['proposed', 'prepared', 'sent', 'rejected', 'unresolved'] as const) {
      recordDecision(store, status, { status });
    }
    recordDecision(store, 'missing-candidate');
    store.db.prepare("UPDATE decisions SET selected='unknown' WHERE id='missing-candidate'").run();
    recordDecision(store, 'after-settlement', { at: 25 });
    recordDecision(store, 'wrong-run', { runId: 'other' });
    const [outcome] = store.recentOutcomes(timestamp(30), 'current');
    expect(outcome?.decisions).toEqual([
      {
        decisionId: 'accepted',
        decidedAt: timestamp(10),
        tableSeq: 22,
        street: 'flop',
        board: ['2h', '3d', '4s'],
        holeCards: ['Ah', 'Kd'],
        action: 'raise',
        source: 'jev',
        fallbackReason: null,
        amount: 120,
      },
    ]);
    expect(JSON.stringify(outcome)).not.toContain('Qc');
    outcome!.decisions[0]!.board.push('Ac');
    expect(store.recentOutcomes(timestamp(30), 'current')[0]?.decisions[0]?.board).toHaveLength(3);
  });

  it('keeps actual decision source and failure reason in accepted historical feedback', () => {
    const store = fixture();
    settle(store);
    recordDecision(store, 'fallback');
    store.db
      .prepare('UPDATE decisions SET source=?,fallback_reason=? WHERE id=?')
      .run('fallback', 'model_budget_exhausted', 'fallback');
    const history = store.recentOutcomes(timestamp(30), 'current');
    const context = buildContext(state('current'), [], {
      asOf: timestamp(30),
      recentOutcomes: history,
    });
    expect(context.recentOutcomes[0]?.decisions[0]).toMatchObject({
      source: 'fallback',
      fallbackReason: 'model_budget_exhausted',
    });
    expect(context.recentOutcomes[0]?.strategy).toBe('jev');
  });

  it.each(['missing', 'negative'] as const)(
    'recovers a %s legacy watermark only from the latest prior turn of the same run and hand',
    (version) => {
      const store = fixture();
      settle(store);
      recordDecision(store, 'legacy', { legacy: version === 'missing', seq: -1 });
      turn(store, { seq: 6, at: 8 });
      turn(store, { seq: 8, at: 9 });
      turn(store, { seq: 9, at: 10 });
      turn(store, { seq: 10, at: 11 });
      turn(store, { seq: 11, runId: 'other', at: 10 });
      turn(store, { seq: 12, handId: 'another', at: 10 });
      turn(store, { seq: 13, type: 'table_state', at: 10 });
      expect(store.recentOutcomes(timestamp(30), 'current')[0]?.decisions[0]?.tableSeq).toBe(9);
    },
  );

  it('keeps modern watermarks and never substitutes unrelated or missing legacy evidence', () => {
    const store = fixture();
    settle(store);
    recordDecision(store, 'modern');
    recordDecision(store, 'legacy', { legacy: true });
    turn(store, { seq: 10, at: 11 });
    turn(store, { seq: 11, runId: 'other' });
    turn(store, { seq: 12, handId: 'another' });
    expect(store.recentOutcomes(timestamp(30), 'current')[0]?.decisions).toEqual([
      expect.objectContaining({ decisionId: 'modern', tableSeq: 22 }),
    ]);
    turn(store, { seq: 7, at: 8 });
    turn(store, { at: 9 });
    // The latest turn has no sequence; borrowing an older turn would invent authority.
    expect(store.recentOutcomes(timestamp(30), 'current')[0]?.decisions).toEqual([
      expect.objectContaining({ decisionId: 'modern', tableSeq: 22 }),
    ]);
  });

  it('retains the last eight valid decisions and exposes truncation', () => {
    const store = fixture();
    settle(store);
    for (let index = 0; index < 10; index++) {
      recordDecision(store, `decision-${index}`, { at: index + 1, seq: index });
    }
    for (let index = 0; index < 10; index++) {
      recordDecision(store, `unverified-${index}`, { at: 11, legacy: true });
    }
    const summaries = summarizeRecentOutcomes(
      store.recentOutcomes(timestamp(30), 'current'),
      timestamp(30),
      'current',
    );
    expect(summaries[0]?.decisionsTruncated).toBe(true);
    expect(summaries[0]?.decisions.map((decision) => decision.decisionId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `decision-${index + 2}`),
    );
  });

  it('orders same-timestamp decisions by their authority sequence before applying the limit', () => {
    const store = fixture();
    settle(store);
    for (let index = 0; index < 12; index++) {
      recordDecision(store, `decision-${String(11 - index).padStart(2, '0')}`, { seq: index });
    }
    const [summary] = summarizeRecentOutcomes(
      store.recentOutcomes(timestamp(30), 'current'),
      timestamp(30),
      'current',
    );
    expect(summary?.decisionsTruncated).toBe(true);
    expect(summary?.decisions.map((decision) => decision.tableSeq)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('records strategy and code versions with a run', () => {
    vi.stubEnv('APP_REVISION', 'test-revision');
    const store = fixture();
    const config = JSON.parse(
      String(store.db.prepare("SELECT config FROM runs WHERE id='live'").get()?.config),
    );
    expect(config).toMatchObject({
      strategyVersions: STRATEGY_VERSIONS,
      codeRevision: 'test-revision',
    });
  });

  it('keeps outcome history queryable while the knowledge-based fast path saves only its frozen decision context', async () => {
    const store = fixture();
    settle(store);
    recordDecision(store, 'past-decision');
    const policy = {
      decide: vi.fn(async (context: DecisionContext, choices: Candidate[]) => ({
        candidateId: choices[0]!.id,
        selected: choices[0]!.id,
        source: 'baseline' as const,
        explanation: `Received ${context.recentOutcomes.length} prior outcomes`,
        latencyMs: 1,
      })),
    };
    const current = state('current');
    const feedback = vi.spyOn(store, 'recentOutcomes');
    const result = await decide(
      {
        key: authorityKey(current),
        state: current,
        controller: new AbortController(),
        deadlineAt: Date.now() + 10_000,
        recovered: false,
        opponents: [],
      },
      { apiKey: 'unused-test-key', policy, store },
      'live',
      1000,
    );
    expect(result).not.toBeNull();
    expect(policy.decide).toHaveBeenCalledOnce();
    const input = policy.decide.mock.calls[0]![0];
    expect(feedback).not.toHaveBeenCalled();
    expect(input.recentOutcomes).toEqual([]);
    expect(input.knowledge?.pin.handId).toBe('current');
    expect(store.recentOutcomes(result!.decision.createdAt, 'current')).toEqual([
      expect.objectContaining({
        handId: 'past',
        profitBb: 6,
        decisions: [expect.objectContaining({ decisionId: 'past-decision', tableSeq: 22 })],
      }),
    ]);
    expect(input.asOf).toBe(result!.decision.createdAt);
    expect(input.strategyVersions).toEqual(STRATEGY_VERSIONS);
    store.saveDecision(result!.decision);
    const saved = store.db
      .prepare('SELECT context FROM decisions WHERE id=?')
      .get(result!.decision.id);
    expect(JSON.parse(String(saved?.context))).toEqual(input);
    current.board.push('Ac');
    expect(result!.decision.context.board).toEqual(['2h', '3d', '4s']);
  });
});
