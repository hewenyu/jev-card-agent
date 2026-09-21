import { describe, expect, it, vi } from 'vitest';
import { buildContext, createInitialState } from '../src/core/index.js';
import type { Candidate, ProviderAttempt, ProviderMeter } from '../src/core/types.js';
import {
  HybridPolicy,
  JevProvider,
  ReasoningProvider,
  type ReasoningPolicy,
} from '../src/policies/index.js';

const context = buildContext({
  ...createInitialState(),
  handId: 'h',
  heroSeat: 0,
  holeCards: ['Ah', 'Ad'],
});
const candidates: Candidate[] = [
  { id: 'check', action: 'check', label: 'Check' },
  { id: 'raise_to_40', action: 'raise', amount: 40, label: 'Raise to 40' },
];
const choice = (selected: string, ids: string[]) => ({
  type: 'choice',
  choice: selected,
  confidence: 0.8,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
});
const jevAnswer = (route?: boolean, selected = 'check') => ({
  model: 'jev-1.13.0',
  usage: { input_tokens: 120, output_tokens: 30 },
  answers: {
    action: choice(
      selected,
      candidates.map((c) => c.id),
    ),
    ...(route === undefined ? {} : { needs_analysis: choice(route ? 'yes' : 'no', ['yes', 'no']) }),
  },
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const analysisResponse = (model = 'gpt-6-astra') => ({
  model,
  status: 'completed',
  usage: { input_tokens: 200, output_tokens: 80 },
  output: [
    { type: 'reasoning', summary: [{ text: 'private hidden reasoning' }] },
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Prefer the smaller raise; visible aces are a premium starting pair.',
        },
      ],
    },
  ],
});
const messagesResponse = (model = 'claude-opus-5') => ({
  model,
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 40 },
  content: [
    { type: 'thinking', thinking: 'private hidden reasoning' },
    { type: 'text', text: 'A small raise is a reasonable candidate.' },
  ],
});
function reasoning(
  fetcher: typeof fetch,
  protocol: 'responses' | 'messages' = 'responses',
  meter?: ProviderMeter,
) {
  return new ReasoningProvider({
    apiKey: 'fixture-secret',
    baseUrl: 'https://example.com/v1',
    model: protocol === 'responses' ? 'gpt-6-astra' : 'claude-opus-5',
    protocol,
    fetch: fetcher,
    meter,
  });
}
function jev(route: boolean) {
  const calls: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    return response(
      jevAnswer(
        calls.length === 1 ? route : undefined,
        calls.length === 1 ? 'check' : 'raise_to_40',
      ),
    );
  };
  return { provider: new JevProvider({ apiKey: 'fixture', fetch: fetcher }), calls };
}
describe('reasoning HTTP protocols', () => {
  it('preserves known Jev usage and probability diagnostics when the distribution violates the API contract', async () => {
    const attempts: ProviderAttempt[] = [];
    const body = jevAnswer();
    body.answers.action.probabilities = { check: 0.2, raise_to_40: 0.8 };
    const provider = new JevProvider({
      apiKey: 'fixture',
      fetch: async () => response(body),
      meter: {
        before: () => 'r',
        after: (attempt) => {
          attempts.push(attempt);
        },
      },
    });
    await expect(provider.decide(context, candidates)).rejects.toThrow('highest probability');
    expect(attempts[0]?.usage).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(attempts[0]?.diagnostics).toMatchObject({
      choice: 'check',
      probabilitySum: 1,
      maximumProbability: 0.8,
    });
  });
  it('preserves Jev usage even when the answer fails structural validation', async () => {
    const attempts: ProviderAttempt[] = [];
    const provider = new JevProvider({
      apiKey: 'fixture',
      fetch: async () =>
        response({
          model: 'jev-1.13.0',
          usage: { input_tokens: 17, output_tokens: 4 },
          answers: {},
        }),
      meter: {
        before: () => 'r',
        after: (attempt) => {
          attempts.push(attempt);
        },
      },
    });
    await expect(provider.decide(context, candidates)).rejects.toThrow('jev_invalid_response');
    expect(attempts[0]?.usage?.input_tokens).toBe(17);
  });
  it('uses Responses with a fixed model and keeps only final analysis and usage', async () => {
    let request: Record<string, unknown> = {};
    const meter: ProviderMeter = { before: vi.fn(() => 'r'), after: vi.fn() };
    const provider = reasoning(
      async (input, init) => {
        expect(input).toBe('https://example.com/v1/responses');
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(analysisResponse());
      },
      'responses',
      meter,
    );
    const result = await provider.analyze(context, candidates);
    expect(request).toMatchObject({
      model: 'gpt-6-astra',
      store: false,
      stream: false,
      reasoning: { effort: 'low' },
      max_output_tokens: 1200,
    });
    expect(result.attempt.usage?.output_tokens).toBe(80);
    expect(JSON.stringify(result)).not.toContain('private hidden reasoning');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(meter.after).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', provider: 'responses' }),
      'r',
    );
  });
  it('uses Messages headers/adaptive thinking and excludes thinking blocks', async () => {
    const result = await reasoning(async (input, init) => {
      expect(input).toBe('https://example.com/v1/messages');
      expect(init?.headers).toMatchObject({
        'x-api-key': 'fixture-secret',
        'anthropic-version': '2023-06-01',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        thinking: { type: 'adaptive' },
        stream: false,
        max_tokens: 1200,
      });
      return response(messagesResponse());
    }, 'messages').analyze(context, candidates);
    expect(result.actualModel).toBe('claude-opus-5');
    expect(result.analysis).toContain('small raise');
    expect(JSON.stringify(result)).not.toContain('private hidden reasoning');
  });
  it.each(['responses', 'messages'] as const)(
    'rejects proxy model substitution for %s while retaining billed usage',
    async (protocol) => {
      const attempts: ProviderAttempt[] = [];
      const provider = reasoning(
        async () =>
          response(
            protocol === 'responses'
              ? analysisResponse('gpt-5.6-luna')
              : messagesResponse('claude-other'),
          ),
        protocol,
        {
          before: () => 'r',
          after: (attempt) => {
            attempts.push(attempt);
          },
        },
      );
      await expect(provider.analyze(context, candidates)).rejects.toThrow(
        'reasoning_model_mismatch',
      );
      expect(attempts[0]?.status).toBe('model_mismatch');
      expect(attempts[0]?.usage?.input_tokens).toBeGreaterThan(0);
    },
  );
  it('only accepts explicitly configured actual-model aliases', async () => {
    const provider = new ReasoningProvider({
      apiKey: 'fixture',
      baseUrl: 'https://example.com',
      model: 'gpt-6-astra',
      allowedActualModels: ['gpt-6-astra-snapshot'],
      protocol: 'responses',
      fetch: async () => response(analysisResponse('gpt-6-astra-snapshot')),
    });
    expect((await provider.analyze(context, candidates)).actualModel).toBe('gpt-6-astra-snapshot');
  });
  it('rejects incomplete output and records unavailable usage as unknown', async () => {
    const attempts: ProviderAttempt[] = [];
    const provider = reasoning(
      async () => response({ ...analysisResponse(), status: 'incomplete', usage: undefined }),
      'responses',
      {
        before: () => 'r',
        after: (attempt) => {
          attempts.push(attempt);
        },
      },
    );
    await expect(provider.analyze(context, candidates)).rejects.toThrow(
      'reasoning_invalid_response',
    );
    expect(attempts[0]?.usage).toBeNull();
  });
  it('does not call the provider when its separate budget is exhausted', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      reasoning(fetcher, 'responses', { before: () => null, after: () => {} }).analyze(
        context,
        candidates,
      ),
    ).rejects.toThrow('provider_budget_exhausted');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a late response even if a custom transport ignores cancellation', async () => {
    const controller = new AbortController();
    const provider = reasoning(async () => {
      controller.abort();
      return response(analysisResponse());
    });
    await expect(
      provider.analyze(context, candidates, { signal: controller.signal }),
    ).rejects.toThrow('reasoning_cancelled');
  });
});
describe('Jev-directed optional analysis', () => {
  it('retains the completed advisory when the second Jev call fails', async () => {
    let calls = 0;
    const first = new JevProvider({
      apiKey: 'fixture',
      fetch: async () =>
        ++calls === 1 ? response(jevAnswer(true)) : new Response('error', { status: 503 }),
    });
    const result = await new HybridPolicy({
      jev: first,
      reasoning: reasoning(async () => response(analysisResponse())),
    }).decide(context, candidates);
    expect(result.candidateId).toBe('check');
    expect(result.routing?.analysis).toContain('smaller raise');
    expect(result.routing?.actualModel).toBe('gpt-6-astra');
    expect(result.attempts).toHaveLength(3);
  });
  it('skips reasoning when Jev says no without a confidence threshold', async () => {
    const initial = jev(false);
    const analyze = vi.fn<ReasoningPolicy['analyze']>();
    const result = await new HybridPolicy({ jev: initial.provider, reasoning: { analyze } }).decide(
      context,
      candidates,
    );
    expect(result.routing?.outcome).toBe('skipped_by_jev');
    expect(result.candidateId).toBe('check');
    expect(analyze).not.toHaveBeenCalled();
    expect(initial.calls).toHaveLength(1);
  });
  it('asks reasoning only on a yes route, then asks Jev to reconsider the same candidates', async () => {
    const initial = jev(true);
    const provider = reasoning(async () => response(analysisResponse()));
    const result = await new HybridPolicy({ jev: initial.provider, reasoning: provider }).decide(
      context,
      candidates,
    );
    expect(result.candidateId).toBe('raise_to_40');
    expect(result.routing?.outcome).toBe('reconsidered');
    expect(result.attempts?.map((a) => a.provider)).toEqual(['jev', 'responses', 'jev']);
    expect(initial.calls).toHaveLength(2);
    expect(initial.calls[1]?.state).toMatchObject({
      ...context,
      untrusted_advisory: expect.any(String),
    });
    const first = initial.calls[0]?.questions as Record<string, unknown>;
    const second = initial.calls[1]?.questions as Record<string, unknown>;
    expect(second.action).toEqual(first.action);
  });
  it('keeps the original Jev choice when analysis fails, without disguising the failure', async () => {
    const initial = jev(true);
    const provider = reasoning(async () => new Response('private', { status: 503 }));
    const result = await new HybridPolicy({ jev: initial.provider, reasoning: provider }).decide(
      context,
      candidates,
    );
    expect(result.candidateId).toBe('check');
    expect(result.routing?.errorCode).toBe('reasoning_http_503');
    expect(result.attempts).toHaveLength(2);
    expect(initial.calls).toHaveLength(1);
  });
  it('does not begin analysis when the combined budgets cannot fit', async () => {
    const initial = jev(true);
    const analyze = vi.fn<ReasoningPolicy['analyze']>();
    const result = await new HybridPolicy({
      jev: initial.provider,
      reasoning: { analyze },
      totalBudgetMs: 100,
      minimumReasoningBudgetMs: 200,
      reconsiderReserveMs: 20,
    }).decide(context, candidates);
    expect(result.routing?.outcome).toBe('insufficient_time');
    expect(analyze).not.toHaveBeenCalled();
  });
  it('never returns an actionable proposal after the caller deadline', async () => {
    const initial = jev(true);
    const controller = new AbortController();
    const provider = reasoning(async () => {
      controller.abort();
      return response(analysisResponse());
    });
    await expect(
      new HybridPolicy({ jev: initial.provider, reasoning: provider }).decide(context, candidates, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(initial.calls).toHaveLength(1);
  });
});
