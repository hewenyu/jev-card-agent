import type {
  EvidenceMetric,
  ResearchBatchV2,
  ResearchModelMetadata,
  ResearchProposalV2,
  ResearchScope,
} from '../research/contracts.js';
export type AsyncLlmMode = 'off' | 'shadow' | 'live';
export interface ProposalRecord {
  proposalId: string;
  contentHash: string;
  receivedAt: string;
  model: ResearchModelMetadata;
  batch: ResearchBatchV2;
  proposal: ResearchProposalV2;
  status: 'pending' | 'approved' | 'rejected' | 'published';
}
export interface PublishedAdvice {
  publicationId: string;
  publicationSeq: number;
  proposalId: string;
  contentHash: string;
  topicKey: string;
  adviceRevision: number;
  evidenceWatermark: number;
  evidenceCutoff: string;
  receivedAt: string;
  publishedAt: string;
  availableAt: string;
  expiresAt: string;
  basePolicyVersion: string;
  scope: ResearchScope;
  priority: number;
  hypothesis: string;
  guidance: string;
  limitations: string[];
  metrics: EvidenceMetric[];
  invalidateWhen: ResearchProposalV2['invalidateWhen'];
  approvalSource: 'manual' | 'approved_recipe';
}
export interface AdviceBundle {
  schemaVersion: 'advice-bundle-v1';
  bundleHash: string;
  mode: AsyncLlmMode;
  basePolicyVersion: string;
  selectorVersion: 'scope-selector-v1';
  availableAt: string;
  publications: PublishedAdvice[];
  supportMetrics?: EvidenceMetric[];
  maxItems?: number;
}
export interface AdviceMatchContext {
  street: string;
  players: number;
  position?: string;
  stackBucket?: string;
  betBucket?: string;
  opponentKeys: string[];
  rulesetVersion: string;
  basePolicyVersion: string;
  currentMetrics?: EvidenceMetric[];
}
export interface AdviceProjection {
  id: string;
  scope: { streets: string[]; opponentKeys: string[] };
  observation: string;
  guidance: string;
  limitations: string[];
  evidence: string[];
}
export interface AdviceSelection {
  items: AdviceProjection[];
  audit: Array<{ id: string; reason: string }>;
  serializedBytes: number;
}
export interface AdviceReview {
  actor: string;
  note: string;
  passedScenarios: string[];
}
export interface AdviceAudit {
  auditId: number;
  at: string;
  action: string;
  subjectId: string;
  actor: string;
  details: Record<string, unknown>;
}
