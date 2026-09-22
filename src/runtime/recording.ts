import type { DecisionRecord, RuntimeStore, StoredAction } from './types.js';

/** Persist the decision before any action can be sent, including failed/cancelled traces. */
export function recordDecision(
  store: RuntimeStore,
  decision: DecisionRecord,
  action?: StoredAction,
): void {
  const started = Date.now();
  store.saveDecision(decision);
  if (action) store.prepareAction(action);
  if (decision.timing) {
    decision.timing.persistenceMs += Math.max(0, Date.now() - started);
    store.saveDecisionTiming?.(decision.id, decision.timing);
  }
}
