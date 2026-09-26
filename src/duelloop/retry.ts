import type { ErrorCode } from 'duelloop';

/** Included in the model behavior digest because delay policy changes execution. */
export const RETRY_POLICY = Object.freeze({
  baseDelayMs: 100,
  multiplier: 2,
  additiveJitterRatio: 0.25,
  retryAfter: 'minimum-delay',
  malformedAnswer: 'immediate-bounded-retry',
  jevHttp403MaxAttempts: 3,
});

export interface RetryFailure {
  code: ErrorCode;
  httpStatus?: number;
  failureKind?: 'network' | 'http';
  retryAfterMs?: number;
}

/** null is terminal; zero preserves bounded retries of malformed score answers. */
export function retryDelay(
  error: RetryFailure,
  retryIndex: number,
  options: { retryForbidden?: boolean } = {},
): number | null {
  if (!['MODEL_INVALID', 'MODEL_TIMEOUT'].includes(error.code)) return null;
  if (
    error.httpStatus !== undefined &&
    error.httpStatus !== 429 &&
    !(error.httpStatus === 403 && options.retryForbidden) &&
    error.httpStatus < 500
  )
    return null;
  const transient =
    error.httpStatus !== undefined ||
    error.failureKind === 'network' ||
    error.code === 'MODEL_TIMEOUT';
  if (!transient) return 0;
  const base = RETRY_POLICY.baseDelayMs * RETRY_POLICY.multiplier ** retryIndex;
  return Math.max(
    base + Math.random() * base * RETRY_POLICY.additiveJitterRatio,
    error.retryAfterMs ?? 0,
  );
}

/** Keep the caller's deadline; large server delays must not overflow Node timers. */
export function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = delayMs;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    const schedule = () => {
      const startedAt = performance.now();
      timer = setTimeout(
        () => {
          remaining -= performance.now() - startedAt;
          if (signal.aborted) finish(false);
          else if (remaining <= 0) finish(true);
          else schedule();
        },
        Math.min(remaining, 2_147_483_647),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    schedule();
  });
}
