import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from 'duelloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCandidates } from '../src/core/candidates.js';
import { buildContext } from '../src/core/context.js';
import { candidateCriteria, POKER_INSTRUCTIONS, projectJevState } from '../src/core/harness.js';
import { createInitialState } from '../src/core/state.js';
import type { PokerState, RawMessage } from '../src/core/types.js';
import { prepareReplayPlan, validateReplayPlan, type ReplayPlan } from '../src/duelloop/plan.js';
import { Store } from '../src/storage/store.js';

const runId = 'archived-live-run';
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const requestHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function archivedInput(street: Exclude<PokerState['street'], 'idle'> = 'preflop') {
  const state: PokerState = {
    ...createInitialState(),
    tableId: 'original-table',
    handId: 'original-hand',
    turnToken: 'fixture-only-never-in-request',
    street,
    heroSeat: 0,
    dealerSeat: 1,
    actorSeat: 0,
    holeCards: ['Ah', 'Kd'],
    board: ['2c', '7d', 'Ts', 'Jc', '3h'].slice(
      0,
      { preflop: 0, flop: 3, turn: 4, river: 5 }[street],
    ),
    bigBlind: 20,
    smallBlind: 10,
    pot: 60,
    historyIncomplete: false,
    seats: [
      { seat: 0, name: 'Hero', stack: 980, bet: 20, status: 'active', inHand: true },
      { seat: 1, name: 'Opponent', stack: 960, bet: 40, status: 'active', inHand: true },
    ],
    validActions: [{ action: 'fold' }, { action: 'call' }, { action: 'raise', min: 80, max: 1000 }],
  };
  const context = buildContext(state);
  const candidates = buildCandidates(state);
  const request = {
    model: 'jev-1.13.0',
    state: projectJevState(context),
    questions: {
      action: {
        type: 'choice',
        instructions: POKER_INSTRUCTIONS,
        criteria: candidateCriteria(context, candidates),
      },
    },
  };
  return { request: JSON.parse(JSON.stringify(request)) as typeof request, candidates };
}

function rehashPlan(plan: ReplayPlan) {
  const { planHash: _oldHash, ...content } = plan;
  plan.planHash = digest(content);
  return plan;
}

describe('DuelLoop plans from archived live observations', () => {
  let directory: string;
  let rawPath: string;
  let store: Store;
  let closed: boolean;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'duelloop-plan-'));
    rawPath = join(directory, 'source.sqlite');
    store = new Store(rawPath);
    closed = false;
    store.beginRun({ id: runId, kind: 'live', strategy: 'jev', startedAt: at(0), config: {} });
  });
  afterEach(() => {
    if (!closed) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function insert(
    id: string,
    minute = 1,
    street: Exclude<PokerState['street'], 'idle'> = 'preflop',
    options: {
      handId?: string;
      complete?: boolean;
      status?: string;
      source?: string;
      fallbackReason?: string;
      mutateRequest?: (request: ReturnType<typeof archivedInput>['request']) => void;
      corruptHash?: boolean;
    } = {},
  ) {
    const handId = options.handId ?? `hand-${id}`;
    const { request, candidates } = archivedInput(street);
    options.mutateRequest?.(request);
    store.db
      .prepare(
        `INSERT OR IGNORE INTO hands(id,run_id,table_id,hand_number,board,hero_cards,
          profit,big_blind,status,started_at,ended_at,complete)
         VALUES(?,?, 'original-table',1,'["Qs","Qc","Qh","Qd","Ac"]','["Ah","Kd"]',
          -120,20,?,?,?,?)`,
      )
      .run(
        handId,
        runId,
        options.complete === false ? 'playing' : 'complete',
        at(0),
        at(50),
        options.complete === false ? 0 : 1,
      );
    store.db
      .prepare(
        `INSERT INTO decisions(id,run_id,hand_id,street,created_at,context,candidates,
          proposal,source,selected,status,latency_ms,cost_usd,model,fallback_reason)
         VALUES(?,?,?,?,?,?,?,?,?,'call',?,340,0,'jev-1.13.0',?)`,
      )
      .run(
        id,
        runId,
        handId,
        street,
        at(minute),
        JSON.stringify({ doNotReconstruct: 'later-mutated-context', profit: -120 }),
        JSON.stringify(candidates),
        JSON.stringify({
          request,
          requestHash: options.corruptHash ? '0'.repeat(64) : requestHash(request),
        }),
        options.source ?? 'jev',
        options.status ?? 'accepted',
        options.fallbackReason ?? null,
      );
    return request;
  }

  const prepare = (limit = 24) => prepareReplayPlan({ rawPath, runId, limit });

  it('preserves exact archived input and leaves the source database unchanged', () => {
    const request = insert('accepted');
    store.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
      .run('unrelated-current-state', JSON.stringify({ pot: 99999, profit: 99999 }));
    store.close();
    closed = true;
    const before = readFileSync(rawPath);

    const plan = prepare();

    expect(plan.samples).toHaveLength(1);
    expect(plan.samples[0]).toMatchObject({
      decisionId: 'accepted',
      runId,
      tableId: 'original-table',
      originalAt: at(1),
      originalChoice: 'call',
      originalLatencyMs: 340,
      request,
      inputHash: digest(request),
    });
    expect(plan.samples[0]!.request).toEqual(request);
    expect(plan.samples[0]!.request.state.board).toEqual([]);
    expect(JSON.stringify(plan.samples[0]!.request)).not.toContain('later-mutated-context');
    expect(JSON.stringify(plan.samples[0]!.request)).not.toContain('99999');
    expect(readFileSync(rawPath)).toEqual(before);
    expect(validateReplayPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it('selects streets before filling from a busy preflop bucket, then sorts by time', () => {
    for (let index = 1; index <= 6; index++) insert(`pre-${index}`, index);
    insert('flop', 10, 'flop');
    insert('turn', 11, 'turn');
    insert('river', 12, 'river');

    const plan = prepare(4);

    expect(plan.samples.map((sample) => sample.decisionId)).toEqual([
      'pre-1',
      'flop',
      'turn',
      'river',
    ]);
    expect(plan.scanned).toBe(9);
    expect(plan.excluded.outside_sample_limit).toBe(5);
    expect(plan.scanLimitReached).toBe(false);
  });

  it('records settled outcomes once per selected hand without adding them to model input', () => {
    const handId = 'same-hand';
    const original = insert('first', 1, 'preflop', { handId });
    insert('second', 2, 'flop', { handId });
    insert('not-selected', 3);

    const plan = prepare(2);

    expect(plan.historicalOutcomes).toEqual([
      { handId, completedAt: at(50), netChips: -120, bigBlind: 20 },
    ]);
    expect(plan.samples[0]!.request).toEqual(original);
    for (const sample of plan.samples) {
      expect(sample.request.state).not.toHaveProperty('netChips');
      expect(sample.request.state).not.toHaveProperty('profit');
      expect(sample.request.state).not.toHaveProperty('historicalOutcomes');
    }
  });

  it('excludes unaccepted, incomplete, fallback, malformed and corrupted archive rows', () => {
    insert('valid');
    insert('sent', 2, 'preflop', { status: 'sent' });
    insert('fallback', 3, 'preflop', { source: 'fallback' });
    insert('annotated-fallback', 4, 'preflop', { fallbackReason: 'fixture-unavailable' });
    insert('incomplete', 5, 'preflop', { complete: false });
    insert('bad-hash', 6, 'preflop', { corruptHash: true });
    insert('incomplete-history', 7, 'preflop', {
      mutateRequest: (request) => {
        request.state.historyIncomplete = true;
      },
    });
    insert('bad-price', 8, 'preflop', {
      mutateRequest: (request) => {
        request.questions.action.criteria.raise_to_80!.raiseToChips = 800;
      },
    });
    insert('legacy', 9);
    store.db.prepare("UPDATE decisions SET proposal='{}' WHERE id='legacy'").run();

    const plan = prepare();

    expect(plan.samples.map((sample) => sample.decisionId)).toEqual(['valid']);
    expect(plan.excluded).toMatchObject({
      not_accepted_pure_model_action: 3,
      incomplete_hand: 1,
      archived_request_hash_mismatch: 1,
      incomplete_archived_state: 1,
      candidate_price_mismatch: 1,
      unsupported_archived_input: 1,
    });
  });

  it('accepts offset timestamps with microseconds using their actual chronological order', () => {
    insert('offset');
    const completedAt = '2025-12-31T17:50:00.123456-07:00';
    store.db.prepare('UPDATE hands SET ended_at=? WHERE id=?').run(completedAt, 'hand-offset');

    const plan = prepare();

    expect(plan.samples.map((sample) => sample.decisionId)).toEqual(['offset']);
    expect(plan.historicalOutcomes[0]!.completedAt).toBe(completedAt);
    expect(plan.excluded).toEqual({ outside_sample_limit: 0 });
  });

  it('does not sample a row after rejecting its malformed completion timestamp', () => {
    insert('broken', 1);
    insert('valid', 2);
    store.db
      .prepare('UPDATE hands SET ended_at=? WHERE id=?')
      .run('not-a-timestamp', 'hand-broken');

    const plan = prepare(1);

    expect(plan.samples.map((sample) => sample.decisionId)).toEqual(['valid']);
    expect(plan.historicalOutcomes.map((outcome) => outcome.handId)).toEqual(['hand-valid']);
    expect(plan.excluded).toMatchObject({ unsupported_archived_input: 1, outside_sample_limit: 0 });
  });

  it('requires an existing live source run and an eligible request', () => {
    expect(() => prepare()).toThrow('No eligible archived requests');
    expect(() => prepareReplayPlan({ rawPath, runId: 'missing' })).toThrow('live source run');
    store.db.prepare("UPDATE runs SET mode='demo' WHERE id=?").run(runId);
    expect(() => prepare()).toThrow('live source run');
  });

  it.each([0, 1001, -1, 2.5])('rejects invalid sample limit %s', (limit) => {
    expect(() => prepare(limit)).toThrow('Replay limit');
  });

  it('detects tampering independently at the plan and archived-request levels', () => {
    insert('valid');
    const plan = prepare();
    plan.samples[0]!.originalChoice = 'fold';
    expect(() => validateReplayPlan(plan)).toThrow('integrity');
    rehashPlan(plan);
    plan.samples[0]!.request.state.dealerSeat = 5;
    rehashPlan(plan);
    expect(() => validateReplayPlan(plan)).toThrow('request_hash_mismatch');
  });

  it.each(['duplicate', 'different-run', 'future-decision'])(
    'rejects %s source identity even with a new plan hash',
    (change) => {
      insert('valid');
      const plan = prepare();
      if (change === 'duplicate') plan.samples.push(structuredClone(plan.samples[0]!));
      if (change === 'different-run') plan.samples[0]!.runId = 'other-run';
      if (change === 'future-decision') plan.samples[0]!.originalAt = '2099-01-01T00:00:00.000Z';
      expect(() => validateReplayPlan(rehashPlan(plan))).toThrow();
    },
  );

  it.each(['unselected-hand', 'duplicate-hand', 'future-outcome', 'before-decision'])(
    'rejects %s outcome even after recomputing integrity',
    (change) => {
      insert('valid');
      const plan = prepare();
      if (change === 'unselected-hand') plan.historicalOutcomes[0]!.handId = 'not-selected';
      if (change === 'duplicate-hand')
        plan.historicalOutcomes.push(structuredClone(plan.historicalOutcomes[0]!));
      if (change === 'future-outcome')
        plan.historicalOutcomes[0]!.completedAt = '2099-01-01T00:00:00.000Z';
      if (change === 'before-decision') plan.historicalOutcomes[0]!.completedAt = at(0);
      expect(() => validateReplayPlan(rehashPlan(plan))).toThrow('outcome');
    },
  );

  it.each(['hidden-field', 'nested-secret', 'price', 'duplicate-candidate', 'river-without-board'])(
    'rejects rehashed structurally unsafe input: %s',
    (change) => {
      insert('valid', 1, 'river');
      const plan = prepare();
      const sample = plan.samples[0]!;
      if (change === 'hidden-field') sample.request.state.opponentHoleCards = ['Ac', 'Ad'];
      if (change === 'nested-secret')
        sample.request.state.session = { nested: { access_token: 'fixture-credential' } };
      if (change === 'price')
        sample.request.questions.action.criteria.raise_to_80!.raiseToChips = 10000;
      if (change === 'duplicate-candidate')
        sample.candidates.push(structuredClone(sample.candidates[0]!));
      if (change === 'river-without-board') sample.request.state.board = [];
      sample.inputHash = digest(sample.request);
      expect(() => validateReplayPlan(rehashPlan(plan))).toThrow();
    },
  );

  it('rejects unknown archive state rather than projecting it into a different replay', () => {
    insert('valid');
    insert('extra-state', 2, 'preflop', {
      mutateRequest: (request) => {
        (request.state as RawMessage).laterOutcome = -120;
      },
    });
    expect(prepare().excluded).toMatchObject({ unsupported_archived_state: 1 });
  });
});
