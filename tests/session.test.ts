import { describe, expect, it } from 'vitest';
import { buildContext, createInitialState } from '../src/core/index.js';
import { buildSession, sessionId, MAX_SESSION_ANALYSIS } from '../src/core/session.js';
import { Store } from '../src/storage/store.js';
import { decide, authorityKey } from '../src/evaluation/legacy/decision.js';
import { ProviderError } from '../src/policies/metering.js';
import type { DecisionRecord } from '../src/runtime/types.js';
import type { ProviderAttempt } from '../src/core/types.js';

function recorded(id: string, seq: number, tableId = 'table', handId = 'hand'): DecisionRecord {
  return {
    id,
    runId: 'run',
    handId,
    createdAt: '2026-01-01T00:00:00.000Z',
    context: buildContext({
      ...createInitialState(),
      tableId,
      handId,
      lastTableSeq: seq,
      street: 'flop',
    }),
    candidates: [{ id: 'check', action: 'check', label: 'Check' }],
    proposal: {
      candidateId: 'check',
      selected: 'check',
      source: 'jev',
      explanation: 'Synthetic',
      latencyMs: 1,
      routing: { analysis: `Advisory ${id}` },
    },
    fallbackReason: null,
  };
}
function storeFixture() {
  const store = new Store(':memory:');
  for (const id of ['run', 'reconnected'])
    store.beginRun({
      id,
      kind: 'live',
      strategy: 'jev-reasoning',
      startedAt: '2026-01-01T00:00:00.000Z',
      config: {},
    });
  return store;
}

describe('durable hand sessions', () => {
  it('retains cancelled analysis as a turn without implying an action was taken', () => {
    const store = storeFixture();
    try {
      const record = recorded('cancelled', 1);
      record.status = 'cancelled';
      record.proposal.candidateId = '';
      record.proposal.selected = '';
      store.saveDecision(record);
      const turns = store.sessionTurns('table', 'hand', '2026-01-02T00:00:00.000Z', 2);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        status: 'cancelled',
        action: null,
        analysis: 'Advisory cancelled',
      });
      expect(buildSession('table', 'hand', 'next', turns).turn).toBe(2);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM actions').get()?.n).toBe(0);
    } finally {
      store.close();
    }
  });
  it('restores earlier turns across runs while excluding future, same-turn and foreign table/hand data', () => {
    const store = storeFixture();
    try {
      for (const record of [
        recorded('first', 1),
        { ...recorded('second', 3), runId: 'reconnected' },
        recorded('future-seq', 12),
        recorded('same-turn', 8),
        recorded('foreign-table', 2, 'other'),
        recorded('foreign-hand', 2, 'table', 'other'),
        { ...recorded('future-time', 4), createdAt: '2026-01-03T00:00:00.000Z' },
      ])
        store.saveDecision(record);
      const memory = store.sessionTurns('table', 'hand', '2026-01-02T00:00:00.000Z', 8);
      expect(memory.map((item) => item.decisionId)).toEqual(['first', 'second']);
      const session = buildSession('table', 'hand', 'current', memory);
      expect(session.id).toBe(sessionId('table', 'hand'));
      expect(session.id).not.toBe(sessionId('table', 'next-hand'));
      expect(session.turn).toBe(3);
      expect(session.previousTurns[1]?.analysis).toBe('Advisory second');
      expect(session.previousTurns[0]?.status).toBe('proposed');
    } finally {
      store.close();
    }
  });
  it('distinguishes historical fallback actions from successful Jev decisions in session memory', () => {
    const store = storeFixture();
    try {
      const fallback = recorded('fallback', 1);
      fallback.proposal.source = 'fallback';
      fallback.fallbackReason = 'model_budget_exhausted';
      store.saveDecision(fallback);
      store.saveDecision(recorded('jev', 2));
      const session = buildSession(
        'table',
        'hand',
        'next',
        store.sessionTurns('table', 'hand', '2026-01-02T00:00:00.000Z', 3),
      );
      expect(
        session.previousTurns.map(({ source, fallbackReason }) => ({ source, fallbackReason })),
      ).toEqual([
        { source: 'fallback', fallbackReason: 'model_budget_exhausted' },
        { source: 'jev', fallbackReason: null },
      ]);
    } finally {
      store.close();
    }
  });

  it('bounds retained analysis and turns while preserving the real ordinal and truncation evidence', () => {
    const store = storeFixture();
    try {
      for (let i = 0; i < 15; i++) {
        const record = recorded(`decision-${i}`, i);
        record.proposal.routing = { analysis: 'a'.repeat(MAX_SESSION_ANALYSIS + 100) };
        store.saveDecision(record);
      }
      const memory = store.sessionTurns('table', 'hand', '2026-01-02T00:00:00.000Z', 16);
      const session = buildSession('table', 'hand', 'next', memory);
      expect(session.turn).toBe(16);
      expect(session.previousTurns).toHaveLength(12);
      expect(session.previousTurns[0]?.tableSeq).toBe(3);
      expect(session.previousTurns.at(-1)?.analysis).toHaveLength(MAX_SESSION_ANALYSIS);
      expect(
        session.previousTurns.reduce((sum, turn) => sum + (turn.analysis?.length ?? 0), 0),
      ).toBeLessThanOrEqual(12000);
      expect(session.truncated).toBe(true);
    } finally {
      store.close();
    }
  });
  it('freezes session memory into the exact decision and preserves analysis/attempts when final Jev fails', async () => {
    const store = storeFixture();
    try {
      store.saveDecision(recorded('previous', 1));
      const state = {
        ...createInitialState(),
        tableId: 'table',
        handId: 'hand',
        lastTableSeq: 3,
        turnToken: 'authority-not-a-session-id',
        validActions: [{ action: 'check' as const }],
      };
      const analysisAttempt: ProviderAttempt = {
        id: 'analysis',
        provider: 'messages',
        purpose: 'analysis',
        requestedModel: 'test-model',
        actualModel: 'test-model',
        status: 'succeeded',
        usage: { input_tokens: 10, output_tokens: 20 },
        latencyMs: 1,
      };
      const jevAttempt: ProviderAttempt = {
        ...analysisAttempt,
        id: 'jev-failure',
        provider: 'jev',
        purpose: 'reconsider',
        status: 'failed',
      };
      const progress: string[] = [];
      const result = await decide(
        {
          key: authorityKey(state),
          state,
          controller: new AbortController(),
          deadlineAt: Date.now() + 10000,
          recovered: false,
          opponents: [],
        },
        {
          apiKey: 'unused',
          store,
          policy: {
            decide: async (context, _candidates, options) => {
              expect(context.session?.turn).toBe(2);
              expect(context.session?.previousTurns[0]?.decisionId).toBe('previous');
              options?.onProgress?.({
                phase: 'jev',
                analysis: 'Observed small sample; checking is supported.',
                thinking: 'Provider summary',
                thinkingSource: 'summary',
                attempts: [analysisAttempt],
              });
              throw new ProviderError('jev_failed', jevAttempt);
            },
          },
        },
        'reconnected',
        1000,
        (value) => progress.push(value.phase),
      );
      expect(result?.decision.id).toBe(result?.decision.context.session?.decisionId);
      expect(result?.decision.proposal.attempts?.map((attempt) => attempt.id)).toEqual([
        'analysis',
        'jev-failure',
      ]);
      expect(result?.decision.proposal.routing?.thinking).toBe('Provider summary');
      expect(result?.decision.fallbackReason).toBe('jev_failed');
      expect(result?.action).toBeNull();
      expect(result?.decision.status).toBe('failed');
      expect(result?.decision.proposal.source).toBe('unavailable');
      expect(progress).toEqual(['jev']);
      expect(JSON.stringify(result?.decision.context.session)).not.toContain(state.turnToken);
    } finally {
      store.close();
    }
  });
});
