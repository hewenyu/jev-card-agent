import type { RuntimeDependencies, RuntimeStatus } from './types.js';

/** Observe asynchronous hand preparation without blocking WebSocket state ingestion. */
export function pinHand(
  dependencies: Pick<RuntimeDependencies, 'engine'>,
  snapshot: Pick<RuntimeStatus, 'state'>,
  lifetime: AbortController,
  onError: (error: unknown) => void,
): void {
  // Synchronous failures retain the surrounding event handler's normal failure path.
  const pending = dependencies.engine.pin(snapshot.state, new Date().toISOString());
  void Promise.resolve(pending).catch((error: unknown) => {
    // A stopped/replaced runtime must not fail a later run through an old pin task.
    if (!lifetime.signal.aborted) onError(error);
  });
}
