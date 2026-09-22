import type {
  AdviceBundle,
  AdviceMatchContext,
  AdviceProjection,
  AdviceSelection,
  AsyncLlmMode,
  PublishedAdvice,
} from './advice-types.js';
import { hashAdviceBundle, validateAdviceBundle } from './advice-validator.js';

export const ADVICE_LIMITS = {
  maxItems: 3,
  itemCharacters: 300,
  totalCharacters: 900,
  utf8Bytes: 4096,
} as const;
export function emptyAdviceBundle(mode: AsyncLlmMode, basePolicyVersion: string): AdviceBundle {
  const content: Omit<AdviceBundle, 'bundleHash'> = {
    schemaVersion: 'advice-bundle-v1',
    mode,
    basePolicyVersion,
    selectorVersion: 'scope-selector-v1',
    availableAt: '1970-01-01T00:00:00.000Z',
    publications: [],
  };
  return { ...content, bundleHash: hashAdviceBundle(content) };
}
function mismatch(item: PublishedAdvice, context: AdviceMatchContext): string | null {
  const scope = item.scope;
  if (
    scope.basePolicyVersion !== context.basePolicyVersion ||
    scope.rulesetVersion !== context.rulesetVersion
  )
    return 'incompatible_policy';
  if (!scope.streets.includes(context.street as (typeof scope.streets)[number]))
    return 'street_mismatch';
  if (!scope.players.includes(context.players)) return 'players_mismatch';
  if (scope.positions.length && !scope.positions.some((value) => value === context.position))
    return 'position_mismatch';
  if (
    scope.stackBuckets.length &&
    !scope.stackBuckets.some((value) => value === context.stackBucket)
  )
    return 'stack_mismatch';
  if (scope.betBuckets.length && !scope.betBuckets.some((value) => value === context.betBucket))
    return 'bet_mismatch';
  if (
    scope.opponentKeys.length &&
    !scope.opponentKeys.every((key) => context.opponentKeys.includes(key))
  )
    return 'opponent_mismatch';
  for (const condition of item.invalidateWhen) {
    if (condition.kind === 'opponent_absent') {
      if (
        !scope.opponentKeys.length ||
        !scope.opponentKeys.every((key) => context.opponentKeys.includes(key))
      )
        return 'invalidated_opponent';
      continue;
    }
    // If a refreshed metric is supplied, validate it before use; absent metrics retain
    // the immutable evidence that passed publication review.
    const original = item.metrics.find((candidate) => candidate.id === condition.metricRef);
    const refreshed = context.currentMetrics?.find(
      (candidate) =>
        candidate.id === condition.metricRef &&
        candidate.name === original?.name &&
        candidate.opponentKey === original?.opponentKey &&
        candidate.throughEventId >= original.throughEventId &&
        Date.parse(candidate.availableAt) >= Date.parse(original.availableAt),
    );
    const metric = refreshed ?? original;
    if (
      !metric ||
      !Number.isFinite(metric.numerator) ||
      !Number.isInteger(metric.denominator) ||
      metric.denominator <= 0 ||
      metric.numerator < 0 ||
      metric.numerator > metric.denominator
    )
      return 'invalidated_metric_missing';
    const ratio = metric.numerator / metric.denominator;
    if (
      (condition.kind === 'metric_below' && ratio < condition.threshold) ||
      (condition.kind === 'metric_above' && ratio > condition.threshold)
    )
      return 'invalidated_metric_condition';
  }
  return null;
}
function projection(item: PublishedAdvice): AdviceProjection {
  return {
    id: item.publicationId,
    scope: { streets: item.scope.streets, opponentKeys: item.scope.opponentKeys },
    observation: item.hypothesis,
    guidance: item.guidance,
    limitations: item.limitations,
    evidence: item.metrics.map(
      (metric) => `${metric.name}: ${metric.numerator}/${metric.denominator}`,
    ),
  };
}
function characterCount(item: AdviceProjection): number {
  return [...[item.observation, item.guidance, ...item.limitations, ...item.evidence].join('')]
    .length;
}
/** Uses only the immutable hand bundle; never queries a database or awaits research. */
export function selectAdvice(
  bundle: AdviceBundle,
  context: AdviceMatchContext,
  admissionAt?: string,
): AdviceSelection {
  validateAdviceBundle(bundle);
  const result: AdviceSelection = { items: [], audit: [], serializedBytes: 2 };
  let characters = 0;
  for (const item of [...bundle.publications].sort(
    (a, b) => b.priority - a.priority || b.publicationSeq - a.publicationSeq,
  )) {
    let reason =
      bundle.mode !== 'live'
        ? 'mode_disabled'
        : mismatch(item, {
            ...context,
            currentMetrics: context.currentMetrics ?? bundle.supportMetrics,
          });
    if (
      admissionAt &&
      (!Number.isFinite(Date.parse(admissionAt)) ||
        Date.parse(item.availableAt) > Date.parse(admissionAt))
    )
      reason = 'not_available_at_boundary';
    if (admissionAt && Date.parse(item.expiresAt) <= Date.parse(admissionAt))
      reason = 'expired_at_boundary';
    const projected = projection(item);
    const count = characterCount(projected);
    if (!reason && result.items.length >= (bundle.maxItems ?? ADVICE_LIMITS.maxItems))
      reason = 'item_limit';
    if (!reason && count > ADVICE_LIMITS.itemCharacters) reason = 'item_character_limit';
    if (!reason && characters + count > ADVICE_LIMITS.totalCharacters)
      reason = 'total_character_limit';
    const bytes = Buffer.byteLength(JSON.stringify([...result.items, projected]), 'utf8');
    if (!reason && bytes > ADVICE_LIMITS.utf8Bytes) reason = 'utf8_limit';
    if (!reason) {
      result.items.push(projected);
      characters += count;
      result.serializedBytes = bytes;
    }
    result.audit.push({ id: item.publicationId, reason: reason ?? 'adopted' });
  }
  return result;
}
