import { PokerRuntime as HostRuntime } from '../../src/runtime/runtime.js';
import { decide } from '../../src/evaluation/legacy/decision.js';
import type { Policy } from '../../src/core/types.js';
import type { RuntimeDependencies } from '../../src/runtime/types.js';

/** Preserve existing host fault-injection fixtures without exposing legacy policies to live. */
export class PokerRuntime extends HostRuntime {
  constructor(dependencies: Omit<RuntimeDependencies, 'engine'> & { policy: Policy }) {
    super({
      ...dependencies,
      engine: {
        pin: (state, at) => {
          dependencies.store.pinKnowledge?.(state, at);
        },
        decide: (task, runId, budgetMs, progress) =>
          decide(task, dependencies, runId, budgetMs, progress),
        beforeSend() {},
        async resume() {},
        rememberTurn() {},
        loadTurn: () => undefined,
      },
    });
  }
}
