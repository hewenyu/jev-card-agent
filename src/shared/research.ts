/** Anonymous research views contain no raw batch, provider response, endpoint or operator note. */
export interface ResearchSummary {
  mode: 'off' | 'shadow' | 'live';
  configuredMode: 'off' | 'shadow' | 'live';
  running: boolean;
  error: string | null;
  pending: number;
  executing: number;
  failed: number;
  awaitingReview: number;
  approved: number;
  published: number;
  expired: number;
  withdrawn: number;
  lastCompletedAt: string | null;
  latestPublicationAt: string | null;
  knownCostUsd: number | null;
  unpricedCalls: number;
  unknownUsageCalls: number;
  attempts: number;
  adoptedDecisions: number;
  evaluatedDecisions: number;
  unmatchedDecisions: number;
  latestAdviceAgeMs: number | null;
}
export interface ResearchPublicView {
  status: ResearchSummary;
  proposals: Array<{
    id: string;
    kind: string;
    status: string;
    receivedAt: string;
    model: string | null;
    evidenceHands: number;
  }>;
  publications: Array<{
    id: string;
    proposalId: string;
    revision: number;
    sequence: number;
    status: 'published' | 'expired' | 'withdrawn' | 'superseded';
    publishedAt: string;
    expiresAt: string;
    evidenceCutoff: string;
    guidance: string;
    approvalSource: string;
  }>;
}
