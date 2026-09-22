import { z } from 'zod';

const id = z.string().min(1).max(160);
const timestamp = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ResearchScopeSchema = z.strictObject({
  streets: z
    .array(z.enum(['preflop', 'flop', 'turn', 'river']))
    .min(1)
    .max(4),
  players: z
    .array(z.number().int().min(2).max(6))
    .min(1)
    .max(5)
    .describe('Number of players still active in the hand at decision time, not table capacity.'),
  positions: z
    .array(z.enum(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']))
    .max(6)
    .default([]),
  stackBuckets: z
    .array(z.enum(['short', 'medium', 'deep']))
    .max(3)
    .default([]),
  betBuckets: z
    .array(z.enum(['none', 'small', 'medium', 'large']))
    .max(4)
    .default([]),
  opponentKeys: z.array(id).max(6).default([]),
  rulesetVersion: id,
  basePolicyVersion: id,
});
export const EvidenceMetricSchema = z.strictObject({
  id,
  name: id,
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().positive(),
  opponentKey: id.optional(),
  handIds: z.array(id).min(1).max(1000),
  throughEventId: z.number().int().positive(),
  availableAt: timestamp,
});
export const EvidenceExampleSchema = z.strictObject({
  id,
  handId: id,
  eventId: z.number().int().positive(),
  availableAt: timestamp,
  opponentKey: id.optional(),
  phase: z.enum(['decision_visible', 'post_settlement']),
  summary: z.string().min(1).max(4000),
});
export const ResearchTriggerSchema = z.strictObject({
  kind: z.enum(['large_investment', 'large_swing', 'showdown']),
  handId: id,
  decisionId: id.optional(),
  eventId: z.number().int().positive(),
  availableAt: timestamp,
});
export const ResearchBatchSchema = z.strictObject({
  batchId: id,
  taskType: z.enum(['opponent_brief', 'leak_review']),
  scopeKey: id,
  basePolicyVersion: id,
  researchPromptVersion: id,
  inputSchemaVersion: z.literal('research-batch-v2'),
  rulesetVersion: id,
  contextSchemaVersion: id,
  sourceSnapshotHash: hash,
  evidenceEventWatermark: z.number().int().positive(),
  cutoff: timestamp,
  eligibleHandIds: z.array(id).min(1).max(1000),
  metrics: z.array(EvidenceMetricSchema).max(128),
  examples: z.array(EvidenceExampleSchema).max(128),
  sampleDefinition: z.string().min(1).max(2000),
  missingness: z.array(z.string().max(500)).max(32),
  disclosureMode: z.string().min(1).max(160),
  triggers: z.array(ResearchTriggerSchema).max(32).optional(),
});
export const InvalidationConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('metric_below'),
    metricRef: id,
    threshold: z.number().min(0).max(1),
  }),
  z.strictObject({
    kind: z.literal('metric_above'),
    metricRef: id,
    threshold: z.number().min(0).max(1),
  }),
  z.strictObject({ kind: z.literal('opponent_absent') }),
]);
export const ResearchProposalSchema = z.strictObject({
  kind: z.enum(['opponent_brief', 'leak_review']),
  basePolicyVersion: id,
  evidenceSnapshotHash: hash,
  evidenceRefs: z.array(id).min(1).max(64),
  counterEvidenceRefs: z.array(id).max(64),
  scope: ResearchScopeSchema,
  hypothesis: z.string().min(1).max(800),
  suggestedGuidance: z.string().min(1).max(300),
  metricRefs: z.array(id).min(1).max(32),
  limitations: z.array(z.string().min(1).max(300)).min(1).max(8),
  invalidateWhen: z.array(InvalidationConditionSchema).max(8),
  proposedRecipeId: id.optional(),
  requiredScenarios: z.array(id).min(1).max(16),
});
export type ResearchScope = z.infer<typeof ResearchScopeSchema>;
export type EvidenceMetric = z.infer<typeof EvidenceMetricSchema>;
export type EvidenceExample = z.infer<typeof EvidenceExampleSchema>;
export type ResearchBatchV2 = z.infer<typeof ResearchBatchSchema>;
export type ResearchProposalV2 = z.infer<typeof ResearchProposalSchema>;
export type ResearchTrigger = z.infer<typeof ResearchTriggerSchema>;
export type InvalidationCondition = z.infer<typeof InvalidationConditionSchema>;
export interface ResearchModelMetadata {
  provider: string;
  requestedModel: string;
  actualModel: string | null;
  attemptId?: string;
}
