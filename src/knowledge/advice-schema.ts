import { z } from 'zod';
import {
  EvidenceMetricSchema,
  InvalidationConditionSchema,
  ResearchScopeSchema,
} from '../research/contracts.js';
const id = z.string().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PublishedAdviceSchema = z.strictObject({
  publicationId: id,
  publicationSeq: z.number().int().positive(),
  proposalId: id,
  contentHash: hash,
  topicKey: hash,
  adviceRevision: z.number().int().positive(),
  evidenceWatermark: z.number().int().positive(),
  evidenceCutoff: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime(),
  availableAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  basePolicyVersion: id,
  scope: ResearchScopeSchema,
  priority: z.number().int().min(-100).max(100),
  hypothesis: z.string().min(1).max(800),
  guidance: z.string().min(1).max(300),
  limitations: z.array(z.string().min(1).max(300)).min(1).max(8),
  metrics: z.array(EvidenceMetricSchema).min(1).max(32),
  invalidateWhen: z.array(InvalidationConditionSchema).max(8),
  approvalSource: z.enum(['manual', 'approved_recipe']),
  recipeId: id.optional(),
});
export const AdviceBundleSchema = z.strictObject({
  schemaVersion: z.literal('advice-bundle-v1'),
  bundleHash: hash,
  mode: z.enum(['off', 'shadow', 'live']),
  basePolicyVersion: id,
  selectorVersion: z.literal('scope-selector-v1'),
  availableAt: z.iso.datetime(),
  publications: z.array(PublishedAdviceSchema).max(256),
  supportMetrics: z.array(EvidenceMetricSchema).max(1024).optional(),
  maxItems: z.number().int().min(1).max(3).optional(),
});
