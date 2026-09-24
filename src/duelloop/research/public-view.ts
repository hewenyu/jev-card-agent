import type { FrameworkResearchView } from '../../shared/framework.js';
import type { ResearchServiceStatus } from './service.js';

/** Explicit public allowlist: never serialize runs.data, prompts, artifacts or config. */
export function publicResearchView(status: ResearchServiceStatus): FrameworkResearchView {
  const research = status.research;
  return {
    enabled: status.enabled,
    running: status.running,
    paused: status.paused,
    state: status.state ?? research?.state ?? (status.enabled ? 'starting' : 'disabled'),
    provider: research?.provider ?? null,
    updatedAt: status.updatedAt,
    error: status.error,
    activeRunId: research?.activeRun?.id ?? null,
    recentRuns: (research?.latestRuns ?? []).map((run) => ({
      id: run.id,
      status: run.status,
      createdAt: new Date(run.createdAt).toISOString(),
      updatedAt: new Date(run.updatedAt).toISOString(),
      modelCalls: run.counters.modelCalls ?? 0,
      providerRequests: run.counters.providerRequests ?? 0,
      evaluationCalls: run.counters.decisionModelCalls ?? 0,
      tokens: run.counters.tokens ?? null,
    })),
    pendingReleases: (research?.pendingReleases ?? []).map((release) => ({
      digest: release.digest,
      validationDigest: release.validationDigest,
    })),
    activationMode: research?.activation.activationMode ?? 'explicit',
    activationPaused: research?.activation.activationPaused ?? false,
  };
}
