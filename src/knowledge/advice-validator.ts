import { createHash } from 'node:crypto';
import {
  ResearchBatchSchema,
  ResearchProposalSchema,
  type ResearchBatchV2,
  type ResearchProposalV2,
} from '../research/contracts.js';
import { AdviceBundleSchema } from './advice-schema.js';
import { KNOWLEDGE_CONTEXT_VERSION, RULESET_VERSION } from './validator.js';
import type { AdviceBundle, PublishedAdvice } from './advice-types.js';
import { validateGuidanceProposal } from './advice-guidance.js';

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function researchBatchHash(
  batch: Omit<ResearchBatchV2, 'sourceSnapshotHash'> | ResearchBatchV2,
): string {
  const { sourceSnapshotHash: _hash, batchId: _id, ...evidence } = batch as ResearchBatchV2;
  return contentHash(evidence);
}
export function opponentKey(name: string): string {
  return `opponent-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
}
export const REQUIRED_REVIEW_SCENARIOS = [
  'evidence-reviewed',
  'scope-reviewed',
  'injection-reviewed',
];
const prohibited =
  /(?:```|\b(?:modify|rewrite|edit|delete|write)\s+(?:the\s+)?(?:source|code|file|config|runtime)\b|\b(?:run|execute)\s+(?:a\s+)?(?:shell|command|script)\b|ignore\s+(?:all\s+)?(?:previous|prior|system)|system\s*prompt|api[ _-]?key|\b(?:submitAction|process\.env|docker|curl|eval\s*\(|exec\s*\(|https?:\/\/)|(?:sk-|apikey_)[\w-]{8}|更改.*(?:源码|配置)|忽略.*(?:指令|规则))/i;

export class AdviceValidator {
  validateBatch(raw: unknown): ResearchBatchV2 {
    const batch = ResearchBatchSchema.parse(raw);
    if (batch.sourceSnapshotHash !== researchBatchHash(batch))
      throw new Error('Evidence snapshot hash mismatch');
    if (
      batch.rulesetVersion !== RULESET_VERSION ||
      batch.contextSchemaVersion !== KNOWLEDGE_CONTEXT_VERSION
    )
      throw new Error('Incompatible research evidence schema');
    const hands = new Set(batch.eligibleHandIds);
    if (hands.size !== batch.eligibleHandIds.length) throw new Error('Duplicate evidence hand');
    const refs = new Set<string>();
    for (const metric of batch.metrics) {
      if (refs.has(metric.id)) throw new Error('Duplicate evidence reference');
      refs.add(metric.id);
      if (
        metric.numerator > metric.denominator ||
        new Set(metric.handIds).size !== metric.handIds.length
      )
        throw new Error('Invalid metric numerator or denominator');
      if (
        metric.handIds.some((id) => !hands.has(id)) ||
        metric.throughEventId > batch.evidenceEventWatermark ||
        Date.parse(metric.availableAt) > Date.parse(batch.cutoff)
      )
        throw new Error('Metric exceeds frozen evidence');
    }
    for (const example of batch.examples) {
      if (refs.has(example.id)) throw new Error('Duplicate evidence reference');
      refs.add(example.id);
      if (
        !hands.has(example.handId) ||
        example.eventId > batch.evidenceEventWatermark ||
        Date.parse(example.availableAt) > Date.parse(batch.cutoff)
      )
        throw new Error('Example exceeds frozen evidence');
    }
    for (const trigger of batch.triggers ?? []) {
      if (
        !hands.has(trigger.handId) ||
        trigger.eventId > batch.evidenceEventWatermark ||
        Date.parse(trigger.availableAt) > Date.parse(batch.cutoff) ||
        !batch.examples.some(
          (example) =>
            example.handId === trigger.handId &&
            example.phase === 'post_settlement' &&
            example.eventId >= trigger.eventId &&
            Date.parse(example.availableAt) >= Date.parse(trigger.availableAt),
        ) ||
        (trigger.decisionId &&
          !batch.examples.some(
            (example) =>
              example.id === `decision-${trigger.decisionId}` &&
              example.handId === trigger.handId &&
              example.phase === 'decision_visible',
          ))
      )
        throw new Error('Trigger exceeds frozen evidence');
    }
    return batch;
  }
  validate(raw: unknown, rawBatch: ResearchBatchV2, now: string): ResearchProposalV2 {
    const batch = this.validateBatch(rawBatch);
    const proposal = ResearchProposalSchema.parse(raw);
    for (const key of [
      'streets',
      'players',
      'positions',
      'stackBuckets',
      'betBuckets',
      'opponentKeys',
    ] as const) {
      const values = proposal.scope[key];
      if (new Set<string | number>(values).size !== values.length)
        throw new Error('Duplicate scope condition');
      values.sort();
    }
    if (Date.parse(batch.cutoff) > Date.parse(now)) throw new Error('Future evidence cutoff');
    if (
      proposal.kind !== batch.taskType ||
      proposal.basePolicyVersion !== batch.basePolicyVersion ||
      proposal.scope.basePolicyVersion !== batch.basePolicyVersion ||
      proposal.scope.rulesetVersion !== batch.rulesetVersion ||
      proposal.evidenceSnapshotHash !== batch.sourceSnapshotHash
    )
      throw new Error('Proposal evidence or policy mismatch');
    const examples = new Map(batch.examples.map((item) => [item.id, item]));
    const metrics = new Map(batch.metrics.map((item) => [item.id, item]));
    if (
      proposal.evidenceRefs.some((ref) => !examples.has(ref)) ||
      proposal.counterEvidenceRefs.some((ref) => !examples.has(ref)) ||
      proposal.metricRefs.some((ref) => !metrics.has(ref))
    )
      throw new Error('Unknown evidence or metric reference');
    const keys = new Set(
      [...batch.metrics, ...batch.examples].flatMap((item) =>
        item.opponentKey ? [item.opponentKey] : [],
      ),
    );
    if (proposal.scope.opponentKeys.some((key) => !keys.has(key)))
      throw new Error('Unverifiable opponent scope');
    if (proposal.kind === 'opponent_brief' && proposal.scope.opponentKeys.length !== 1)
      throw new Error('Opponent brief requires one bounded opponent');
    if (
      proposal.kind === 'opponent_brief' &&
      proposal.metricRefs.some(
        (ref) => metrics.get(ref)?.opponentKey !== proposal.scope.opponentKeys[0],
      )
    )
      throw new Error('Metric opponent mismatch');
    for (const condition of proposal.invalidateWhen) {
      if (
        condition.kind !== 'opponent_absent' &&
        !proposal.metricRefs.includes(condition.metricRef)
      )
        throw new Error('Unknown invalidation metric');
    }
    const text = [proposal.hypothesis, proposal.suggestedGuidance, ...proposal.limitations].join(
      '\n',
    );
    if (
      [...text].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
      })
    )
      throw new Error('Control characters in advice text');
    if (prohibited.test(text)) throw new Error('Prohibited instruction or capability in advice');
    // All statistical numbers are rendered from verified metric references, never model prose.
    if (/\d/.test(text)) throw new Error('Numeric claims must use verified metricRefs');
    validateGuidanceProposal(proposal, batch);
    return proposal;
  }
}
export function hashPublication(
  advice: Omit<PublishedAdvice, 'contentHash'> | PublishedAdvice,
): string {
  const { contentHash: _hash, ...content } = advice as PublishedAdvice;
  return contentHash(content);
}
export function hashAdviceBundle(bundle: Omit<AdviceBundle, 'bundleHash'> | AdviceBundle): string {
  const { bundleHash: _hash, ...content } = bundle as AdviceBundle;
  return contentHash(content);
}
const validatedBundles = new WeakSet<AdviceBundle>();
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
export function validateAdviceBundle(bundle: AdviceBundle): void {
  if (validatedBundles.has(bundle)) return;
  AdviceBundleSchema.parse(bundle);
  if (
    bundle.schemaVersion !== 'advice-bundle-v1' ||
    bundle.selectorVersion !== 'scope-selector-v1' ||
    !['off', 'shadow', 'live'].includes(bundle.mode) ||
    bundle.bundleHash !== hashAdviceBundle(bundle)
  )
    throw new Error('Advice bundle integrity failure');
  if (!Number.isFinite(Date.parse(bundle.availableAt)) || bundle.publications.length > 256)
    throw new Error('Invalid advice archive');
  if (bundle.mode !== 'live' && bundle.publications.length)
    throw new Error('Non-live bundle includes advice');
  for (const item of bundle.publications) {
    if (
      item.contentHash !== hashPublication(item) ||
      item.basePolicyVersion !== bundle.basePolicyVersion ||
      item.scope.basePolicyVersion !== bundle.basePolicyVersion ||
      item.scope.rulesetVersion !== RULESET_VERSION
    )
      throw new Error('Publication integrity failure');
    if (
      ![
        item.evidenceCutoff,
        item.receivedAt,
        item.publishedAt,
        item.availableAt,
        item.expiresAt,
      ].every((value) => Number.isFinite(Date.parse(value))) ||
      Date.parse(item.evidenceCutoff) > Date.parse(item.receivedAt) ||
      Date.parse(item.receivedAt) > Date.parse(item.publishedAt) ||
      Date.parse(item.publishedAt) > Date.parse(item.availableAt) ||
      Date.parse(item.availableAt) > Date.parse(bundle.availableAt) ||
      Date.parse(item.expiresAt) <= Date.parse(item.availableAt)
    )
      throw new Error('Publication availability integrity failure');
  }
  for (const metric of bundle.supportMetrics ?? []) {
    if (
      metric.numerator > metric.denominator ||
      Date.parse(metric.availableAt) > Date.parse(bundle.availableAt)
    )
      throw new Error('Invalid support metric evidence');
  }
  freeze(bundle);
  validatedBundles.add(bundle);
}
