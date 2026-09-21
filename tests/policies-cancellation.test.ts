import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { buildContext, createInitialState } from '../src/core/index.js';
import type { DecisionProgress } from '../src/core/types.js';
import { JevProvider } from '../src/policies/jev.js';
import { ReasoningProvider } from '../src/policies/reasoning.js';
import { ProviderError } from '../src/policies/metering.js';
import { Store } from '../src/storage/store.js';
import { LedgerMeter } from '../src/storage/provider-meter.js';

const context = buildContext({ ...createInitialState(), tableId: 'table', handId: 'hand' });
const candidates = [{ id: 'check', action: 'check' as const, label: 'Check' }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe.each(['jev', 'reasoning'] as const)('%s cancellation settlement', (provider) => {
  it.each([
    ['fetch', 'resolve'],
    ['fetch', 'reject'],
    ['json', 'resolve'],
    ['json', 'reject'],
  ] as const)('settles before store closure despite late %s %s', async (stage, outcome) => {
    const store = new Store(':memory:');
    const meter = new LedgerMeter(store, 'cancel-run', { totalUsd: 100, runUsd: 100 });
    const after = vi.spyOn(meter, 'after');
    const started = deferred<void>();
    const pendingFetch = deferred<Response>();
    const pendingJson = deferred<unknown>();
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockImplementation(() => {
      started.resolve();
      return pendingJson.promise;
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (stage === 'fetch') {
        started.resolve();
        return pendingFetch.promise;
      }
      return response;
    });
    const controller = new AbortController();
    const progress: DecisionProgress[] = [];
    const options = {
      signal: controller.signal,
      onProgress: (event: DecisionProgress) => progress.push(event),
    };
    const task =
      provider === 'jev'
        ? new JevProvider({ apiKey: 'fixture', fetch: fetcher, meter }).decide(
            context,
            candidates,
            options,
          )
        : new ReasoningProvider({
            apiKey: 'fixture',
            baseUrl: 'https://example.invalid',
            model: 'mock',
            protocol: 'responses',
            fetch: fetcher,
            meter,
          }).analyze(context, candidates, options);
    const completion = task.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await started.promise;
      controller.abort();
      const deadline = new AbortController();
      const result = await Promise.race([
        completion,
        delay(75, 'settlement overdue', { signal: deadline.signal }).catch(() => undefined),
      ]);
      deadline.abort();
      expect(result).toBeInstanceOf(ProviderError);
      expect((result as ProviderError).code).toBe(`${provider}_cancelled`);
      expect((result as ProviderError).attempts).toHaveLength(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(after.mock.calls[0]?.[0]).toMatchObject({ status: 'cancelled', usage: null });
      expect(
        store.db.prepare('SELECT status,charged_nanos,reserved_nanos FROM usage').get(),
      ).toMatchObject({
        status: 'unknown',
        charged_nanos: null,
      });
      expect(
        Number(store.db.prepare('SELECT reserved_nanos FROM usage').get()?.reserved_nanos),
      ).toBeGreaterThan(0);
      store.close();
      const published = progress.length;
      if (stage === 'fetch') {
        if (outcome === 'resolve') pendingFetch.resolve(response);
        else pendingFetch.reject(new Error('late transport failure'));
      } else if (outcome === 'resolve') pendingJson.resolve({ usage: { input_tokens: 42 } });
      else pendingJson.reject(new Error('late body failure'));
      await delay(0);
      expect(after).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(progress).toHaveLength(published);
    } finally {
      controller.abort();
      if (store.db.isOpen) store.close();
    }
  });
});
