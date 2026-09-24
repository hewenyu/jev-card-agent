/** Public read models only: no SDK private artifacts, provider config or task prompt. */
export interface FrameworkUsageView {
  inputTokens: number | null;
  outputTokens: number | null;
  tokensComplete: boolean;
  costUsd: number | null;
  costComplete: boolean;
}
export interface FrameworkResearchRunView {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  modelCalls: number;
  providerRequests: number;
  evaluationCalls: number;
  tokens: number | null;
}
export interface FrameworkResearchView {
  enabled: boolean;
  running: boolean;
  paused: boolean;
  state: string;
  provider: string | null;
  updatedAt: string | null;
  error: string | null;
  activeRunId: string | null;
  recentRuns: FrameworkResearchRunView[];
  pendingReleases: { digest: string; validationDigest: string | null }[];
  activationMode: 'explicit' | 'candidate_only' | 'automatic_after_validation';
  activationPaused: boolean;
}
export interface FrameworkStatusView {
  engine: 'duelloop';
  activeReleaseDigest: string | null;
  handReleaseDigest: string | null;
  factsSnapshotDigest: string | null;
  unresolvedIntents: number;
  research: FrameworkResearchView;
}
export interface FrameworkDecisionView {
  decisionId: string;
  releaseDigest: string;
  strategyDigest: string;
  factsSnapshotDigest: string | null;
  selection: 'argmax' | 'softmax_sample';
  branchId: string | null;
  scores: {
    candidateId: string;
    dimensionId: string;
    score: number;
    confidence: number | null;
    levels: number;
  }[];
  utilities: Record<string, number>;
  selectionProbabilities: Record<string, number>;
  usage: FrameworkUsageView;
  modelDeadline: string | null;
}
