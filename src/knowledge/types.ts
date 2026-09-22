import type { OpponentMemory, BettingStreet } from '../core/opponent-memory.js';
import type { UniformEquity } from '../core/poker-cards.js';
import type { AdviceBundle, AsyncLlmMode } from './advice-types.js';

export interface StrategyCard {
  id: string;
  street: BettingStreet | 'all';
  text: string;
}
export interface KnowledgeSnapshot {
  version: string;
  contentHash: string;
  source: 'baseline' | 'deterministic';
  rulesetVersion: string;
  contextSchemaVersion: string;
  evidenceEventId: number;
  evidenceCutoff: string;
  publishedAt: string;
  expiresAt: string | null;
  opponents: OpponentMemory[];
  cards: StrategyCard[];
  validation: string[];
}
export interface KnowledgePin {
  bindingSchema?: 'hand-knowledge-v2';
  bundleHash?: string;
  bundleAvailableAt?: string;
  bundlePublicationSeq?: number;
  asyncLlmMode?: AsyncLlmMode;
  tableId: string;
  handId: string;
  knowledgeVersion: string;
  snapshotHash: string;
  evidenceEventId: number;
  pinnedAt: string;
  admissibleAt: string;
  reason: 'published' | 'baseline';
  opponentMemory: OpponentMemory[];
  strategyCards: StrategyCard[];
}
export interface KnowledgeBinding {
  pin: KnowledgePin;
  snapshot: KnowledgeSnapshot;
  advice?: AdviceBundle;
}
export interface DecisionKnowledge {
  pin: KnowledgePin;
  snapshot: Omit<KnowledgeSnapshot, 'opponents' | 'cards'>;
}
export interface AuditView {
  decisionId: string;
  inputHash: string | null;
  computedAt: string | null;
  status: 'pending' | 'disabled' | 'failed' | 'complete' | 'unavailable';
  uniformShowdownReference: UniformEquity | null;
  provenance: 'asynchronous_audit_not_model_input';
}
export interface SlowLoopStatus {
  enabled: boolean;
  running: boolean;
  lastCompletedAt: string | null;
  eventCursor: number;
  decisionCursor: number;
  pendingHands: number;
  pendingAudits: number;
  latestVersion: string;
  error: string | null;
}
