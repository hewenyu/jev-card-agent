import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuelLoopError, type ResearchProvider, type ResearchTool } from 'duelloop';
import {
  DeepSeekResearchProvider,
  type ResearchRequestEvent,
} from '../src/duelloop/research/provider.js';
import {
  parseDuelLoopResearchConfig,
  researchWorkerConfig,
} from '../src/duelloop/research/config.js';

const config = () => ({ ...parseDuelLoopResearchConfig({}).provider, apiKey: 'test-secret' });
const input = (tools: ResearchTool[] = []): Parameters<ResearchProvider['run']>[0] => ({
  role: 'researcher',
  prompt: 'Inspect the current evidence',
  tools,
  signal: new AbortController().signal,
  maxTokens: 100000,
  sessionId: 'run:single',
});
const response = (content: unknown[], extra: Record<string, unknown> = {}) =>
  Response.json({
    model: 'deepseek-flash',
    stop_reason: 'end_turn',
    content,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 2,
    },
    ...extra,
  });
const final = () =>
  response([{ type: 'text', text: '{"status":"no_change","reason":"insufficient evidence"}' }]);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DeepSeek SDK research provider', () => {
  it('uses native Messages tools, all cache inputs and one reusable bounded session', async () => {
    const execute = vi.fn().mockResolvedValue({ evidence: 'current' });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          [{ type: 'tool_use', id: 'tool-1', name: 'query_experience', input: { limit: 1 } }],
          { stop_reason: 'tool_use' },
        ),
      )
      .mockResolvedValueOnce(final())
      .mockResolvedValueOnce(final());
    const events: ResearchRequestEvent[] = [];
    const provider = new DeepSeekResearchProvider(config(), {
      fetch: fetcher,
      record: (event) => events.push(event),
    });
    const guard = vi.fn(),
      onUsage = vi.fn();
    const result = await provider.run({
      ...input([
        {
          name: 'query_experience',
          description: 'Read evidence',
          schema: { type: 'object' },
          execute,
        },
      ]),
      beforeModelRequest: guard,
      onUsage,
    });
    expect(result.output).toMatchObject({ status: 'no_change' });
    expect(result.usage).toMatchObject({
      inputTokens: 38,
      outputTokens: 6,
      unknown: false,
      costUnknown: true,
    });
    expect(result.usage.costUsd).toBeUndefined();
    expect(execute).toHaveBeenCalledWith({ limit: 1 });
    const body = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      stream: false,
    });
    expect(body.messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
    });
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(onUsage).toHaveBeenCalledTimes(2);
    await provider.run({ ...input(), role: 'adversary', prompt: 'Find counterexamples' });
    expect(provider.sessionCount()).toBe(1);
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body)).messages).toHaveLength(5);
    await provider.releaseSession('run:single');
    expect(provider.sessionCount()).toBe(0);
    expect(JSON.stringify(events)).not.toContain('test-secret');
  });
  it('preserves thinking and signatures across tools while recording only verifiable counts', async () => {
    const thinking = {
      type: 'thinking',
      thinking: 'private-reasoning',
      signature: 'private-signature',
    };
    const redacted = { type: 'redacted_thinking', data: 'private-redacted' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          [thinking, redacted, { type: 'tool_use', id: 'inspect-1', name: 'inspect', input: {} }],
          { stop_reason: 'tool_use' },
        ),
      )
      .mockResolvedValueOnce(final());
    const events: ResearchRequestEvent[] = [];
    const provider = new DeepSeekResearchProvider(config(), {
      fetch: fetcher,
      record: (event) => events.push(event),
    });
    await provider.run(
      input([
        {
          name: 'inspect',
          description: 'Inspect evidence',
          schema: {},
          execute: async () => ({ samples: 1 }),
        },
      ]),
    );
    const continuation = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(continuation).toMatchObject({
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
    });
    expect(continuation.messages[1].content.slice(0, 2)).toEqual([thinking, redacted]);
    expect(continuation.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'inspect-1',
    });
    expect(events.filter((event) => event.status === 'completed')).toMatchObject([
      {
        thinking: 'enabled',
        effort: 'high',
        thinkingBlocks: 1,
        redactedThinkingBlocks: 1,
        thinkingCharacters: 17,
      },
      {
        thinking: 'enabled',
        effort: 'high',
        thinkingBlocks: 0,
        redactedThinkingBlocks: 0,
        thinkingCharacters: 0,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /private-reasoning|private-signature|private-redacted|Inspect the current evidence/,
    );
  });
  it('omits effort from disabled-thinking requests and their audit events', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(final());
    const events: ResearchRequestEvent[] = [];
    const provider = new DeepSeekResearchProvider(
      { ...config(), thinking: 'disabled' },
      { fetch: fetcher, record: (event) => events.push(event) },
    );
    await provider.run(input());
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toBeUndefined();
    expect(
      events.every((event) => event.thinking === 'disabled' && event.effort === undefined),
    ).toBe(true);
  });
  it('rejects unexpected model identities without retry or executing tools', async () => {
    const execute = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response([{ type: 'tool_use', id: 'x', name: 'query', input: {} }], {
        model: 'unexpected-model',
        stop_reason: 'tool_use',
      }),
    );
    const provider = new DeepSeekResearchProvider(config(), { fetch: fetcher });
    await expect(
      provider.run(input([{ name: 'query', description: 'test', schema: {}, execute }])),
    ).rejects.toMatchObject({ code: 'VERSION_INCOMPATIBLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses tools outside the SDK allowlist', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response([{ type: 'tool_use', id: 'x', name: 'submitAction', input: {} }], {
        stop_reason: 'tool_use',
      }),
    );
    await expect(
      new DeepSeekResearchProvider(config(), { fetch: fetcher }).run(input()),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
  it('performs initial attempt plus three retries under one deadline and preserves unknown usage', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('private error', { status: 503 }));
    const provider = new DeepSeekResearchProvider(config(), { fetch: fetcher });
    const outcome = provider.run(input()).catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({
      code: 'MODEL_INVALID',
      context: { usage: { unknown: true, costUnknown: true } },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('cancels during Retry-After and makes no additional request', async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '300' } }));
    const provider = new DeepSeekResearchProvider(config(), { fetch: fetcher });
    const outcome = provider.run({ ...input(), signal: controller.signal }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retries malformed final JSON three times while retaining each measured token charge', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response([{ type: 'text', text: 'not json' }]));
    const provider = new DeepSeekResearchProvider(config(), { fetch: fetcher });
    await expect(provider.run(input())).rejects.toMatchObject({
      code: 'MODEL_INVALID',
      context: { usage: { inputTokens: 76, outputTokens: 12, unknown: false } },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('records an ignored late response separately after cancellation without executing its tool', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const events: ResearchRequestEvent[] = [];
    const controller = new AbortController();
    const execute = vi.fn();
    const provider = new DeepSeekResearchProvider(config(), {
      fetch: fetcher,
      record: (event) => events.push(event),
    });
    const pending = provider
      .run({
        ...input([{ name: 'tool', description: 'fixture', schema: {}, execute }]),
        signal: controller.signal,
      })
      .catch((error) => error);
    await new Promise((done) => setTimeout(done, 1));
    controller.abort();
    expect(await pending).toMatchObject({
      code: 'CANCELLED',
      context: { usage: { unknown: true } },
    });
    resolve(
      response([{ type: 'tool_use', id: 'late', name: 'tool', input: {} }], {
        stop_reason: 'tool_use',
      }),
    );
    await new Promise((done) => setTimeout(done, 1));
    expect(events.at(-1)).toMatchObject({
      status: 'late',
      usage: { inputTokens: 19, outputTokens: 3, unknown: false },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('records unknown usage without substituting zeros when the response omits usage', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ type: 'text', text: '{}' }], { usage: undefined }));
    await expect(
      new DeepSeekResearchProvider(config(), { fetch: fetcher }).run(input()),
    ).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      context: { usage: { unknown: true, costUnknown: true } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry a completed provider response when durable usage persistence fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(final());
    const provider = new DeepSeekResearchProvider(config(), {
      fetch: fetcher,
      record: (event) => {
        if (event.status === 'completed') throw new Error('disk full');
      },
    });
    await expect(provider.run(input())).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not expose arbitrary tool exception text to the model', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([{ type: 'tool_use', id: 'x', name: 'read', input: {} }], {
          stop_reason: 'tool_use',
        }),
      )
      .mockResolvedValueOnce(final());
    const provider = new DeepSeekResearchProvider(config(), { fetch: fetcher });
    await provider.run(
      input([
        {
          name: 'read',
          description: 'read',
          schema: {},
          execute: async () => {
            throw new DuelLoopError('VALIDATION_REJECTED', 'secret SQL and token');
          },
        },
      ]),
    );
    expect(String(fetcher.mock.calls[1]![1]!.body)).not.toContain('secret SQL');
    expect(String(fetcher.mock.calls[1]![1]!.body)).toContain('VALIDATION_REJECTED');
  });
});

describe('research configuration isolation', () => {
  it('does not inherit old automatic mode, arena credentials or control secrets', () => {
    const config = parseDuelLoopResearchConfig({
      ASYNC_LLM_MODE: 'live',
      OPEN_POKER_API_KEY: 'arena-private',
      API_TOKEN: 'control-private',
    });
    const injected = {
      ...config,
      openPokerApiKey: 'injected',
      provider: { ...config.provider, arenaKey: 'nested' },
    };
    const worker = researchWorkerConfig(injected);
    expect(worker.enabled).toBe(false);
    expect(JSON.stringify(worker)).not.toMatch(/arena-private|control-private|injected|nested/);
    expect(Object.keys(worker.budget)).not.toContain('costUsd');
  });
  it('defaults to enabled high thinking and automatic activation after validation', () => {
    const config = parseDuelLoopResearchConfig({});
    expect(config).toMatchObject({
      activationMode: 'automatic_after_validation',
      provider: { thinking: 'enabled', effort: 'high' },
    });
    expect(researchWorkerConfig(config).activationMode).toBe('automatic_after_validation');
  });
  it.each(['explicit', 'candidate_only', 'automatic_after_validation'] as const)(
    'preserves configured %s activation across worker isolation',
    (activationMode) => {
      const config = parseDuelLoopResearchConfig({ DUELLOOP_ACTIVATION_MODE: activationMode });
      expect(config.activationMode).toBe(activationMode);
      expect(researchWorkerConfig(config).activationMode).toBe(activationMode);
    },
  );
  it.each([
    { DUELLOOP_ACTIVATION_MODE: 'automatic' },
    { DUELLOOP_RESEARCH_THINKING: 'true' },
    { DUELLOOP_RESEARCH_EFFORT: 'low' },
  ])('rejects unsupported activation and thinking configuration: %j', (env) => {
    expect(() => parseDuelLoopResearchConfig(env)).toThrow();
  });
  it('requires both DeepSeek and Jev evaluation keys when enabled', () => {
    expect(() => parseDuelLoopResearchConfig({ DUELLOOP_RESEARCH_ENABLED: 'true' })).toThrow();
    const config = parseDuelLoopResearchConfig({
      DUELLOOP_RESEARCH_ENABLED: 'true',
      DUELLOOP_RESEARCH_API_KEY: 'research',
      JEV_API_KEY: 'score',
    });
    expect(config.provider.apiKey).toBe('research');
    expect(config.jev.apiKey).toBe('score');
  });
  it('never sends a legacy reasoning credential to the research provider', () => {
    const env = { REASONING_API_KEY: 'standard-provider-only', JEV_API_KEY: 'score' };
    expect(parseDuelLoopResearchConfig(env).provider.apiKey).toBe('');
    expect(() =>
      parseDuelLoopResearchConfig({ ...env, DUELLOOP_RESEARCH_ENABLED: 'true' }),
    ).toThrow('requires DUELLOOP_RESEARCH_API_KEY and JEV_API_KEY');
  });
  it('ignores legacy DeepSeek aliases and only uses explicit research settings', () => {
    const legacy = {
      DEEPSEEK_API_KEY: 'legacy-key',
      DEEPSEEK_BASE_URL: 'https://legacy.example/anthropic',
      DEEPSEEK_MODEL: 'deepseek-v4-pro',
    };
    expect(parseDuelLoopResearchConfig(legacy).provider).toMatchObject({
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-flash',
    });
    expect(() =>
      parseDuelLoopResearchConfig({
        ...legacy,
        DUELLOOP_RESEARCH_ENABLED: 'true',
        JEV_API_KEY: 'score',
      }),
    ).toThrow('DUELLOOP_RESEARCH_API_KEY');
    expect(
      parseDuelLoopResearchConfig({
        ...legacy,
        DUELLOOP_RESEARCH_API_KEY: 'explicit-key',
        DUELLOOP_RESEARCH_BASE_URL: 'https://research.example/anthropic',
        DUELLOOP_RESEARCH_MODEL: 'deepseek-flash',
      }).provider,
    ).toMatchObject({
      apiKey: 'explicit-key',
      baseUrl: 'https://research.example/anthropic',
      model: 'deepseek-flash',
    });
  });
});
