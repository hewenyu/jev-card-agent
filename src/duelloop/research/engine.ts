import {
  ResearchOrchestrator,
  ResearchWorker,
  type BehaviorDependencies,
  type DecisionModel,
  type DomainDefinition,
  type DuelLoopStore,
  type EvaluationAdapter,
  type EvaluationProtocol,
  type ResearchProvider,
  type ResearchRun,
} from 'duelloop';
import { DeepSeekResearchProvider } from './provider.js';
import type { DuelLoopResearchConfig } from './config.js';

export interface ResearchEngineOptions {
  store: DuelLoopStore;
  scopeId: string;
  domain: DomainDefinition;
  model: DecisionModel;
  evaluator: EvaluationAdapter;
  dependencies: BehaviorDependencies;
  config: DuelLoopResearchConfig;
  protocol: EvaluationProtocol;
  developmentProtocol: EvaluationProtocol;
  provider?: ResearchProvider;
}
/** SDK owns all run state transitions, evidence cursors and candidate publication. */
export function createResearchEngine(options: ResearchEngineOptions) {
  const { store, scopeId, config } = options;
  // SDK defaults to automatic activation; this application's initial release policy is explicit.
  store.setActivationMode(scopeId, 'explicit');
  const provider =
    options.provider ??
    new DeepSeekResearchProvider(config.provider, {
      record: (event) => {
        if (event.status === 'started') {
          const active = store.activeRun(scopeId);
          if (!active || !event.sessionId.startsWith(`${active.id}:`))
            throw new Error('Research request does not belong to the active run');
          store.consumeBudget(
            active.id,
            'providerRequests',
            config.budget.maxModelCalls *
              config.provider.maxToolTurns *
              (config.provider.maxRetries + 1),
          );
        }
        store.appendEvent('research.provider_request', scopeId, event, 'private');
      },
    });
  const orchestrator = new ResearchOrchestrator({
    store,
    domain: options.domain,
    model: options.model,
    evaluator: options.evaluator,
    dependencies: options.dependencies,
    providers: { researcher: provider },
    mode: 'single',
    budget: config.budget,
    maxRounds: config.maxRounds,
  });
  const worker = new ResearchWorker({
    orchestrator,
    store,
    scopeId,
    protocol: options.protocol,
    developmentProtocol: options.developmentProtocol,
    settledTrajectories: config.settledTrajectories,
    cooldownMs: config.cooldownMs,
    snapshotOptions: { maxDecisions: config.maxDecisions, maxFeedback: config.maxFeedback },
    feedbackTriggerMode: 'first_settlement',
  });
  return {
    orchestrator,
    worker,
    provider,
    async recover(): Promise<ResearchRun | null> {
      const active = store.activeRun(scopeId);
      if (!active) return null;
      const recovered = orchestrator.recover(active.id);
      // A created run has not started remote work; SDK permits starting exactly this run.
      if (recovered.status === 'created') return (await orchestrator.run(active.id)).run;
      return recovered;
    },
    cancel(runId: string) {
      if (store.getRun(runId).scopeId !== scopeId)
        throw new Error('Research run is outside this scope');
      return orchestrator.cancel(runId);
    },
    status() {
      return {
        ...worker.status(),
        scopeId,
        activeRun: store.activeRun(scopeId) ?? null,
        latestRuns: store.listRuns(scopeId, { limit: 20, descending: true }),
        pendingReleases: store
          .pendingReleases(scopeId)
          .map((item) => ({ digest: item.digest, ...item.binding })),
        activation: store.scopeSummary(scopeId),
        provider: provider.id,
        mode: 'single' as const,
        feedbackTriggerMode: 'first_settlement' as const,
      };
    },
    async close() {
      worker.stop();
      await provider.dispose?.();
    },
  };
}
export type ResearchEngine = ReturnType<typeof createResearchEngine>;
export type DuelLoopResearchStatus = ReturnType<ResearchEngine['status']>;
