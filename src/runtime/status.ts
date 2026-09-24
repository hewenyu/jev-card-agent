import type { RuntimeStatus } from './types.js';

/** Observers may only see a pending decision for the currently visible hand. */
export function runtimeStatus(snapshot: RuntimeStatus): RuntimeStatus {
  const value = structuredClone(snapshot);
  if (
    value.decision &&
    (value.decision.handId !== value.state.handId || value.decision.tableId !== value.state.tableId)
  )
    value.decision = null;
  return value;
}
