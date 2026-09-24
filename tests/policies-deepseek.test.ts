import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContext, createInitialState } from '../src/core/index.js';
import type { Candidate, ProviderAttempt } from '../src/core/types.js';
import { DeepSeekProvider } from '../src/policies/deepseek.js';
import { ProviderError } from '../src/policies/metering.js';
import { loadConfig } from '../src/server/config.js';
import { Controller } from '../src/server/controller.js';
import { ledgerFor, reasoningFor } from '../src/evaluation/legacy/providers.js';
import { OpenPokerClient } from '../src/openpoker/client.js';
import { Store } from '../src/storage/store.js';

const context = buildContext({
  ...createInitialState(),
  handId: 'fixture-hand',
  heroSeat: 0,
  holeCards: ['Ah', 'Kd'],
});
const candidates: Candidate[] = [{ id: 'check', action: 'check', label: 'Check' }];
const answer = (changes: Record<string, unknown> = {}) => ({
  id: 'msg_fixture',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-flash',
  stop_reason: 'end_turn',
  stop_sequence: null,
  content: [
    {
      type: 'thinking',
      thinking: 'Consider only the visible information.',
      signature: 'not-retained',
    },
    { type: 'text', text: 'Check is the only supplied candidate.' },
  ],
  usage: {
    input_tokens: 80,
    cache_read_input_tokens: 120,
    cache_creation_input_tokens: 10,
    output_tokens: 30,
    service_tier: 'standard',
  },
  ...changes,
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const stores: Store[] = [];
const store = () => {
  const value = new Store(':memory:');
  stores.push(value);
  return value;
};
afterEach(() => {
  stores.splice(0).forEach((value) => value.close());
  vi.restoreAllMocks();
});

describe('dedicated DeepSeek Messages contract', () => {
  it('uses the official Anthropic endpoint and enabled thinking shape, retains identity and totals cache input once', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const provider = new DeepSeekProvider({
      apiKey: 'deepseek-fixture-key',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return response(answer());
      },
    });
    const result = await provider.analyze(context, candidates);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    const payload = JSON.parse(String(requests[0]!.init?.body));
    expect(payload).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      max_tokens: 4096,
      stream: false,
    });
    expect(payload.thinking).not.toHaveProperty('budget_tokens');
    expect(requests[0]!.init?.headers).toMatchObject({
      'x-api-key': 'deepseek-fixture-key',
      'anthropic-version': '2023-06-01',
    });
    expect(requests[0]!.init?.redirect).toBe('error');
    expect(timeout).toHaveBeenCalledWith(10000);
    expect(result).toMatchObject({
      requestedModel: 'deepseek-flash',
      actualModel: 'deepseek-flash',
      thinkingSource: 'thinking',
      analysis: 'Check is the only supplied candidate.',
      thinking: 'Consider only the visible information.',
    });
    expect(result.attempt).toMatchObject({
      provider: 'deepseek',
      status: 'succeeded',
      retryIndex: 0,
      maxRetries: 3,
      configuration: { thinking: 'enabled', effort: 'high' },
      usage: {
        input_tokens: 210,
        output_tokens: 30,
        cache_read_input_tokens: 120,
        cache_creation_input_tokens: 10,
      },
    });
    expect(JSON.stringify(result)).not.toContain('not-retained');
    expect(JSON.stringify(result)).not.toContain('deepseek-fixture-key');
  });

  it.each([
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['max', 'max'],
  ] as const)('maps effort %s to %s without adaptive thinking', async (effort, expected) => {
    let payload: Record<string, unknown> = {};
    await new DeepSeekProvider({
      apiKey: 'fake',
      effort,
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return response(answer());
      },
    }).analyze(context, candidates);
    expect(payload).toMatchObject({
      thinking: { type: 'enabled' },
      output_config: { effort: expected },
    });
  });

  it('supports disabled thinking and records that choice even when no thinking text is returned', async () => {
    let payload: Record<string, unknown> = {};
    const result = await new DeepSeekProvider({
      apiKey: 'fake',
      thinking: 'disabled',
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return response(
          answer({
            content: [{ type: 'text', text: 'Check.' }],
            usage: {
              input_tokens: 835,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 505,
            },
          }),
        );
      },
    }).analyze(context, candidates);
    expect(payload).toMatchObject({ thinking: { type: 'disabled' } });
    expect(payload).not.toHaveProperty('output_config');
    expect(result.thinking).toBeNull();
    expect(result.attempt.configuration?.thinking).toBe('disabled');
    expect(result.attempt.configuration).not.toHaveProperty('effort');
    expect(result.attempt.usage?.input_tokens).toBe(835);
  });

  it('rejects unknown requested IDs locally and silently remapped actual IDs without retrying', async () => {
    const fetcher = vi.fn(async () => response(answer()));
    expect(
      () => new DeepSeekProvider({ apiKey: 'fake', model: 'deepseek-v4.1-flash', fetch: fetcher }),
    ).toThrow('exact published model ID');
    expect(fetcher).not.toHaveBeenCalled();
    const provider = new DeepSeekProvider({
      apiKey: 'fake',
      model: 'deepseek-v4-pro',
      fetch: fetcher,
    });
    await expect(provider.analyze(context, candidates)).rejects.toMatchObject({
      code: 'reasoning_model_mismatch',
      attempt: {
        actualModel: 'deepseek-flash',
        status: 'model_mismatch',
        usage: { input_tokens: 210 },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures at most three times with independent recorded attempts', async () => {
    const fetcher = vi.fn(async () =>
      fetcher.mock.calls.length < 4 ? new Response('{}', { status: 503 }) : response(answer()),
    );
    const result = await new DeepSeekProvider({ apiKey: 'fake', fetch: fetcher }).analyze(
      context,
      candidates,
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.attempts?.map((value) => value.retryIndex)).toEqual([0, 1, 2, 3]);
    expect(result.attempts?.map((value) => value.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'succeeded',
    ]);
  });

  it('retries malformed messages but does not retry an output-token truncation', async () => {
    let calls = 0;
    const valid = new DeepSeekProvider({
      apiKey: 'fake',
      fetch: async () => response(++calls === 1 ? { bad: true } : answer()),
    });
    const result = await valid.analyze(context, candidates);
    expect(result.attempts?.map((value) => value.status)).toEqual(['failed', 'succeeded']);
    const truncated = vi.fn(async () => response(answer({ stop_reason: 'max_tokens' })));
    await expect(
      new DeepSeekProvider({ apiKey: 'fake', fetch: truncated }).analyze(context, candidates),
    ).rejects.toMatchObject({
      code: 'reasoning_incomplete_response',
      attempt: { usage: { input_tokens: 210 } },
    });
    expect(truncated).toHaveBeenCalledTimes(1);
  });

  it('cancels a noncooperative body under the caller deadline and keeps its unknown charge without retry', async () => {
    const db = store();
    const config = loadConfig({ REASONING_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'fake' });
    let startedBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      startedBody = resolve;
    });
    const fetcher = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            startedBody();
            return await new Promise(() => {});
          },
        }) as Response,
    );
    const provider = new DeepSeekProvider({
      apiKey: 'fake',
      meter: ledgerFor(config, db, 'cancelled'),
      fetch: fetcher,
    });
    const controller = new AbortController();
    const pending = provider.analyze(context, candidates, { signal: controller.signal });
    await bodyStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'reasoning_cancelled',
      attempt: { status: 'cancelled', configuration: { thinking: 'enabled' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.db.prepare('SELECT status, charged_nanos FROM usage').get()).toMatchObject({
      status: 'unknown',
      charged_nanos: null,
    });
  });
});

describe('DeepSeek configuration and ledger', () => {
  it('keeps offline reasoning settings out of live Jev configuration and never persists credentials', async () => {
    const db = store();
    vi.spyOn(OpenPokerClient.prototype, 'activeGame').mockRejectedValue(
      new Error('Synthetic startup failure'),
    );
    const config = loadConfig({
      REASONING_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'private-deepseek',
      DEEPSEEK_THINKING: 'disabled',
      JEV_API_KEY: 'private-jev',
      OPENPOKER_API_KEY: 'private-arena',
    });
    const controller = new Controller(config, db);
    try {
      await controller.start({
        strategy: 'jev',
        buyIn: 2000,
        maxHands: 1,
        maxMinutes: 1,

        autoRebuy: false,
      });
      const serialized = String(db.db.prepare('SELECT config FROM runs').get()?.config);
      expect(JSON.parse(serialized)).not.toHaveProperty('reasoning');
      expect(serialized).not.toContain('private-');
    } finally {
      await controller.close();
    }
  });
  it('selects the dedicated provider with an independent key and forced Messages protocol', () => {
    const withoutKey = loadConfig({
      REASONING_PROVIDER: 'deepseek',
      REASONING_API_KEY: 'standard-secret',
    });
    expect(withoutKey.reasoningApiKey).toBe('');
    expect(() => reasoningFor(withoutKey)).toThrow('key');
    const config = loadConfig({
      REASONING_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      REASONING_API_KEY: 'standard-secret',
      REASONING_API_FORMAT: 'responses',
      DEEPSEEK_THINKING: 'disabled',
      REASONING_EFFORT: 'max',
    });
    expect(config).toMatchObject({
      reasoningApiKey: 'deepseek-secret',
      reasoningProtocol: 'messages',
      reasoningTimeoutMs: 10000,
      deepseekModel: 'deepseek-flash',
      reasoningInputPricePerMillion: 0.3,
      reasoningCacheReadInputPricePerMillion: 0.006,
      reasoningOutputPricePerMillion: 1.2,
    });
    expect(reasoningFor(config)).toBeInstanceOf(DeepSeekProvider);
    expect(
      loadConfig({ ...{}, REASONING_PROVIDER: 'deepseek', DEEPSEEK_MODEL: 'deepseek-v4-pro' }),
    ).toMatchObject({
      reasoningInputPricePerMillion: 1.32,
      reasoningCacheReadInputPricePerMillion: 0.044,
      reasoningOutputPricePerMillion: 3.96,
    });
    expect(
      loadConfig({
        REASONING_PROVIDER: 'deepseek',
        DEEPSEEK_INPUT_PRICE_PER_MILLION: '0.5',
        DEEPSEEK_CACHE_READ_INPUT_PRICE_PER_MILLION: '0.01',
        DEEPSEEK_OUTPUT_PRICE_PER_MILLION: '2',
      }),
    ).toMatchObject({
      reasoningInputPricePerMillion: 0.5,
      reasoningCacheReadInputPricePerMillion: 0.01,
      reasoningOutputPricePerMillion: 2,
    });
    expect(
      loadConfig({ REASONING_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'private' }, true)
        .reasoningApiKey,
    ).toBe('');
    expect(() => loadConfig({ REASONING_EFFORT: 'max' })).toThrow('requires DeepSeek');
  });

  it('charges cached reads separately, retains creation tokens, and treats absent cache fields as uncached', async () => {
    const db = store();
    const config = loadConfig({ REASONING_PROVIDER: 'deepseek' });
    const meter = ledgerFor(config, db, 'priced');
    const provider = new DeepSeekProvider({
      apiKey: 'fake',
      meter,
      fetch: async () => response(answer()),
    });
    const result = await provider.analyze(context, candidates);
    expect(
      db.db.prepare('SELECT charged_nanos,input_tokens,output_tokens FROM usage').get(),
    ).toMatchObject({ charged_nanos: 63720, input_tokens: 210, output_tokens: 30 });
    expect(
      db.db
        .prepare(
          'SELECT cache_read_input_price,cache_read_input_tokens,cache_creation_input_tokens FROM provider_usage',
        )
        .get(),
    ).toMatchObject({
      cache_read_input_price: 0.006,
      cache_read_input_tokens: 120,
      cache_creation_input_tokens: 10,
    });
    const plain = new DeepSeekProvider({
      apiKey: 'fake',
      meter,
      fetch: async () => response(answer({ usage: { input_tokens: 80, output_tokens: 30 } })),
    });
    await plain.analyze(context, candidates);
    expect(db.db.prepare('SELECT SUM(charged_nanos) AS cost FROM usage').get()?.cost).toBe(123720);
    expect(result.attempt.usage?.input_tokens).toBe(210);
  });

  it('migrates old meter tables and settles legacy reservations at their preserved input price', () => {
    const db = store();
    db.db.exec(`CREATE TABLE provider_usage (
      reservation_id TEXT PRIMARY KEY, attempt_id TEXT, provider TEXT, purpose TEXT, requested_model TEXT,
      actual_model TEXT, input_price REAL, output_price REAL, status TEXT, latency_ms REAL, error_code TEXT
    );
    INSERT INTO usage(id,run_id,reserved_nanos,status,created_at) VALUES('legacy','old',1000000,'reserved','2026-01-01');
    INSERT INTO provider_usage(reservation_id,provider,purpose,requested_model,input_price,output_price,status)
      VALUES('legacy','deepseek','analysis','deepseek-flash',0.3,1.2,'reserved');`);
    const meter = ledgerFor(loadConfig({ REASONING_PROVIDER: 'deepseek' }), db, 'new');
    const attempt: ProviderAttempt = {
      id: 'legacy-result',
      provider: 'deepseek',
      purpose: 'analysis',
      requestedModel: 'deepseek-flash',
      actualModel: 'deepseek-flash',
      status: 'succeeded',
      latencyMs: 10,
      usage: {
        input_tokens: 210,
        output_tokens: 30,
        cache_read_input_tokens: 120,
        cache_creation_input_tokens: 10,
      },
    };
    meter.after(attempt, 'legacy');
    meter.after(attempt, 'legacy');
    expect(
      db.db.prepare('SELECT charged_nanos FROM usage WHERE id=?').get('legacy')?.charged_nanos,
    ).toBe(99000);
    expect(() =>
      ledgerFor(loadConfig({ REASONING_PROVIDER: 'deepseek' }), db, 'another'),
    ).not.toThrow();
  });

  it('settles known usage on identity failure rather than discarding a charge', async () => {
    const db = store();
    const config = loadConfig({ REASONING_PROVIDER: 'deepseek' });
    const provider = new DeepSeekProvider({
      apiKey: 'fake',
      meter: ledgerFor(config, db, 'mismatch'),
      fetch: async () => response(answer({ model: 'unexpected-model' })),
    });
    const error = await provider.analyze(context, candidates).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderError);
    expect(db.db.prepare('SELECT status FROM provider_usage').get()?.status).toBe('model_mismatch');
    expect(db.db.prepare('SELECT charged_nanos FROM usage').get()?.charged_nanos).toBe(63720);
  });
});
