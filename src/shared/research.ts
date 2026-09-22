import type { ResearchScheduleEntry } from '../research/scheduling.js';

export interface ResearchActivityCounts {
  attempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  retries: number;
  completedJobs: number;
  insufficientJobs: number;
  evaluatedDecisions: number;
  adoptedDecisions: number;
  unmatchedDecisions: number;
}
export interface ResearchActivity {
  allTime: ResearchActivityCounts;
  currentRun:
    | (ResearchActivityCounts & {
        id: string;
        startedAt: string;
        endedAt: string | null;
      })
    | null;
  decisionsCaughtUp: boolean;
}
export type ResearchScheduleView = ResearchScheduleEntry & { label: string };

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
  activity?: ResearchActivity;
  schedules?: ResearchScheduleView[];
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
    observation?: string;
    limitations?: string[];
    recipeId?: string;
    approvalSource: string;
  }>;
}
