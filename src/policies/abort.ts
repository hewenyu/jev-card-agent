/** Bound provider waits even when an injected transport ignores its AbortSignal. */
export function awaitWithAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      complete();
    };
    const abort = () => finish(() => reject(signal.reason));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    // Keep both handlers attached after cancellation to consume any late rejection.
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}
