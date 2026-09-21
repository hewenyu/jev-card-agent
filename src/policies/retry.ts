import { setTimeout as delay } from 'node:timers/promises';
import type { DecisionOptions, ProviderAttempt } from '../core/types.js';
import { ProviderError } from './metering.js';

export const MODEL_MAX_RETRIES = 3;

function retryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return (
    /^(jev|reasoning)_(network_error|cancelled|invalid_response)$/.test(error.code) ||
    /^reasoning_http_(429|5\d\d)$/.test(error.code) ||
    /^Jev API returned HTTP (429|5\d\d)$/.test(error.code) ||
    /^(Jev returned an unknown or incomplete candidate distribution|Jev probabilities do not sum to one|Jev choice does not match its highest probability|Jev route answer missing)$/.test(
      error.code,
    )
  );
}

/** Retry inference only, with independent metered attempts and the caller's unchanged deadline. */
export async function withProviderRetries<T>(
  operation: (retryIndex: number) => Promise<{ value: T; attempt: ProviderAttempt }>,
  options: DecisionOptions & { phase: 'reasoning' | 'jev'; maxRetries?: number },
): Promise<{ value: T; attempts: ProviderAttempt[] }> {
  const limit = options.maxRetries ?? MODEL_MAX_RETRIES;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MODEL_MAX_RETRIES)
    throw new Error('Model retries must be an integer from 0 to 3');
  const attempts: ProviderAttempt[] = [];
  for (let retryIndex = 0; ; retryIndex++) {
    options.signal?.throwIfAborted();
    try {
      const result = await operation(retryIndex);
      attempts.push(result.attempt);
      options.onProgress?.({ phase: options.phase, attempts: [...attempts] });
      options.signal?.throwIfAborted();
      return { value: result.value, attempts };
    } catch (error) {
      if (error instanceof ProviderError && error.attempt) attempts.push(error.attempt);
      if (error instanceof ProviderError) error.attempts = [...attempts];
      options.onProgress?.({ phase: options.phase, attempts: [...attempts] });
      if (options.signal?.aborted || retryIndex >= limit || !retryable(error)) throw error;
      // Abort interrupts backoff; a cancelled turn never begins a fresh paid request.
      try {
        await delay(50 * 2 ** retryIndex, undefined, { signal: options.signal });
      } catch {
        // Preserve settled attempts when a phase deadline interrupts retry backoff.
        throw error;
      }
    }
  }
}
