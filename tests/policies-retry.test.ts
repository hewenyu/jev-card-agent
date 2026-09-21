import { describe, expect, it, vi } from 'vitest';
import { buildContext, createInitialState } from '../src/core/index.js';
import { buildSession } from '../src/core/session.js';
import type { DecisionProgress, ProviderAttempt } from '../src/core/types.js';
import { JevProvider } from '../src/policies/jev.js';
import { ReasoningProvider } from '../src/policies/reasoning.js';
import { HybridPolicy } from '../src/policies/hybrid.js';
import { ProviderError, ProviderLedgerError } from '../src/policies/metering.js';
import { Store } from '../src/storage/store.js';
import { LedgerMeter } from '../src/storage/provider-meter.js';

const context = buildContext({ ...createInitialState(), tableId: 'table', handId: 'hand' });
const candidates = [{ id: 'check', action: 'check' as const, label: 'Check' }];
const json = (body: unknown) => new Response(JSON.stringify(body));
const jevResponse = () => ({
  model: 'jev-1.13.0',
  usage: { input_tokens: 120, output_tokens: 0 },
  answers: {
    action: { type: 'choice', choice: 'check', confidence: 0.9, probabilities: { check: 1 } },
  },
});
const reasoningResponse = () => ({
  model: 'mock-reasoner',
  status: 'completed',
  usage: { input_tokens: 10, output_tokens: 20 },
  output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Checking is reasonable.' }] },
  ],
});
const reasoner = (fetcher: typeof fetch, extra = {}) =>
  new ReasoningProvider({
    apiKey: 'fixture',
    baseUrl: 'https://example.invalid',
    model: 'mock-reasoner',
    protocol: 'responses',
    fetch: fetcher,
    ...extra,
  });

describe('provider retries share a deadline and keep independent charges', () => {
  it('retries network, 429 and 5xx before succeeding on the fourth independently metered attempt', async () => {
    const store = new Store(':memory:');
    const progress: DecisionProgress[] = [];
    let calls = 0;
    try {
      const meter = new LedgerMeter(store, 'retry-run', { totalUsd: 100, runUsd: 100 });
      const provider = reasoner(
        async () => {
          calls++;
          if (calls === 1) throw new TypeError('network failed');
          if (calls === 2) return new Response('', { status: 429 });
          if (calls === 3) return new Response('', { status: 503 });
          return json(reasoningResponse());
        },
        { meter },
      );
      const result = await provider.analyze(context, candidates, {
        onProgress: (event) => progress.push(event),
      });
      expect(calls).toBe(4);
      expect(result.attempts?.map((attempt) => attempt.retryIndex)).toEqual([0, 1, 2, 3]);
      expect(result.attempts?.every((attempt) => attempt.maxRetries === 3)).toBe(true);
      expect(new Set(result.attempts?.map((attempt) => attempt.id)).size).toBe(4);
      const rows = store.db
        .prepare('SELECT status,charged_nanos,reserved_nanos FROM usage ORDER BY rowid')
        .all();
      expect(rows).toHaveLength(4);
      expect(
        rows.slice(0, 3).every((row) => row.status === 'unknown' && Number(row.reserved_nanos) > 0),
      ).toBe(true);
      expect(rows[3]?.status).toBe('settled');
      expect(progress.at(-1)?.attempts).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it('retries invalid Jev choices, server errors and malformed JSON, then stops at success', async () => {
    let calls = 0;
    const settled: ProviderAttempt[] = [];
    const provider = new JevProvider({
      apiKey: 'fixture',
      meter: {
        before: () => `r-${calls}`,
        after: (attempt) => settled.push(attempt),
      },
      fetch: async () => {
        calls++;
        if (calls === 1) {
          const body = jevResponse();
          body.answers.action.choice = 'illegal';
          return json(body);
        }
        if (calls === 2) return new Response('', { status: 500 });
        if (calls === 3) return new Response('{broken');
        return json(jevResponse());
      },
    });
    const result = await provider.decide(context, candidates);
    expect(calls).toBe(4);
    expect(settled).toHaveLength(4);
    expect(result.attempts?.map((attempt) => attempt.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'succeeded',
    ]);
    expect(result.attempts?.[0]?.usage?.input_tokens).toBe(120);
    expect(result.attempts?.at(-1)?.retryIndex).toBe(3);
  });

  it('reports exactly four attempts when all retries fail', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    let failure: unknown;
    try {
      await reasoner(fetcher).analyze(context, candidates);
    } catch (error) {
      failure = error;
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).attempts).toHaveLength(4);
  });

  it.each([401, 402, 403])('does not retry HTTP %s for either provider', async (status) => {
    const fetcher = vi.fn(async () => new Response('', { status }));
    await expect(reasoner(fetcher).analyze(context, candidates)).rejects.toThrow(String(status));
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(
      new JevProvider({ apiKey: 'fixture', fetch: fetcher }).decide(context, candidates),
    ).rejects.toThrow(String(status));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry a proxy model substitution or exhausted model budget', async () => {
    const fetcher = vi.fn(async () => json({ ...reasoningResponse(), model: 'different-model' }));
    await expect(reasoner(fetcher).analyze(context, candidates)).rejects.toThrow(
      'reasoning_model_mismatch',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(
      reasoner(fetcher, { meter: { before: () => null, after() {} } }).analyze(context, candidates),
    ).rejects.toThrow('provider_budget_exhausted');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts backoff without starting another paid request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    await expect(
      reasoner(fetcher).analyze(context, candidates, {
        signal: controller.signal,
        onProgress: () => setTimeout(() => controller.abort(), 5),
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry failed ledger writes or invoke Jev after a reasoning settlement failure', async () => {
    const reasoningFetch = vi.fn(async () => json(reasoningResponse()));
    const jevFetch = vi.fn(async () => json(jevResponse()));
    const provider = reasoner(reasoningFetch, {
      meter: {
        before: () => 'r',
        after() {
          throw new Error('ledger write failed');
        },
      },
    });
    const hybrid = new HybridPolicy({
      reasoning: provider,
      jev: new JevProvider({ apiKey: 'fixture', fetch: jevFetch }),
    });
    await expect(hybrid.decide(context, candidates)).rejects.toBeInstanceOf(ProviderLedgerError);
    expect(reasoningFetch).toHaveBeenCalledTimes(1);
    expect(jevFetch).not.toHaveBeenCalled();
    const beforeFailed = new JevProvider({
      apiKey: 'fixture',
      fetch: jevFetch,
      meter: {
        before() {
          throw new Error('ledger unavailable');
        },
        after() {},
      },
    });
    await expect(beforeFailed.decide(context, candidates)).rejects.toThrow('ledger unavailable');
    expect(jevFetch).not.toHaveBeenCalled();
  });

  it('retains attempts when the reasoning phase deadline expires during retry backoff', async () => {
    const progress: DecisionProgress[] = [];
    const reasoningFetch = vi.fn(async () => new Response('', { status: 503 }));
    const hybrid = new HybridPolicy({
      reasoning: reasoner(reasoningFetch),
      jev: new JevProvider({ apiKey: 'fixture', fetch: async () => json(jevResponse()) }),
      totalBudgetMs: 500,
      reconsiderReserveMs: 490,
    });
    const result = await hybrid.decide(context, candidates, {
      onProgress: (event) => progress.push(event),
    });
    expect(reasoningFetch).toHaveBeenCalledTimes(1);
    expect(result.routing?.outcome).toBe('analysis_failed_jev_final');
    expect(result.attempts?.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
    const lengths = progress.map((event) => event.attempts?.length ?? 0);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(progress.at(-1)?.attempts).toHaveLength(2);
  });
});

describe('final Jev request size', () => {
  it('fits serialized advisory text including JSON escaping and preserves complete analysis separately', async () => {
    const largeContext = {
      ...context,
      history: Array.from({ length: 24 }, (_, i) => ({
        handId: 'hand',
        tableSeq: i,
        seat: i % 6,
        name: 'Opponent-Longish-Name',
        action: 'raise' as const,
        street: 'flop' as const,
        amount: 100,
        toCallBefore: 20,
        actionId: 'action-uuid-12345678-abcd-4321-8765-123456789012',
        timestamp: '2026-09-21T00:00:00.000Z',
      })),
    };
    largeContext.session = buildSession(
      'table',
      'hand',
      'current',
      Array.from({ length: 3 }, (_, i) => ({
        decisionId: `d-${i}`,
        createdAt: '2026-09-21T00:00:00.000Z',
        tableSeq: i,
        street: 'flop' as const,
        status: 'accepted',
        action: { kind: 'check' as const },
        analysis: 'a'.repeat(4000),
        analysisTruncated: false,
      })),
    );
    const analysis = '"\\\n'.repeat(10000);
    let body = '';
    const provider = new JevProvider({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        body = String(init?.body);
        return json(jevResponse());
      },
    });
    const hybrid = new HybridPolicy({
      jev: provider,
      reasoning: {
        analyze: async () => ({
          analysis,
          requestedModel: 'mock',
          actualModel: 'mock',
          thinking: null,
          thinkingSource: 'not_provided',
          attempt: {
            id: 'reasoning-attempt',
            provider: 'responses',
            purpose: 'analysis',
            requestedModel: 'mock',
            actualModel: 'mock',
            status: 'succeeded',
            usage: null,
            latencyMs: 1,
          },
        }),
      },
    });
    const result = await hybrid.decide(largeContext, candidates);
    expect(body.length).toBeLessThanOrEqual(48000);
    const request = JSON.parse(body);
    expect(request.state.advisory_metadata).toMatchObject({
      originalCharacters: analysis.length,
      truncated: true,
    });
    expect(request.state.advisory_metadata.usedCharacters).toBe(
      request.state.untrusted_advisory.length,
    );
    expect(result.routing?.analysis).toBe(analysis);
    expect(result.routing?.advisory).toEqual(request.state.advisory_metadata);
  });

  it('reports oversized context explicitly without reserving funds or retrying', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const before = vi.fn(() => 'r');
    const provider = new JevProvider({
      apiKey: 'fixture',
      fetch: fetcher,
      meter: { before, after() {} },
    });
    const oversized = { ...context, holeCards: ['a'.repeat(50000)] };
    await expect(provider.reconsider(oversized, candidates, 'Advice')).rejects.toThrow(
      'jev_input_too_large',
    );
    expect(before).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(reasoner(fetcher).analyze(oversized, candidates)).rejects.toThrow(
      'reasoning_input_too_large',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
