import type { ResearchBatchV2, ResearchProposalV2 } from '../research/contracts.js';
import { ADVICE_LIMITS } from './advice-selector.js';

export const GUIDANCE_RECIPE_ID = 'opponent-guidance-v1';
export const GUIDANCE_SMALL_SAMPLE_HANDS = 30;
export const GUIDANCE_SMALL_SAMPLE_TTL_MS = 4 * 60 * 60 * 1000;

const certainty =
  /\b(?:always|never)\s+(?:bluffs?|calls?|folds?|raises?)\b|\b(?:guaranteed|certainly|definitely|must)\s+(?:win|have|hold|bluff)|\b(?:opponent|villain)\s+(?:has|holds)\s+(?:a |an |the |pocket )?(?:ace|king|queen|jack|pair|flush|straight|full house|[AKQJT]{2})|\b(?:known|certain|exact)\s+(?:hole cards|private cards|range|bluff rate)\b|必定|必然|一定(?:有|是|会)|从不诈唬|总是诈唬|对手底牌是/i;
const unconditional =
  /\b(?:always|never|every time|regardless|unconditionally)\b.*\b(?:call|fold|raise|bet|shove|all.in|check)\b|\b(?:call|fold|raise|bet|shove|check)\b.*\b(?:always|every time|regardless|unconditionally)\b|无条件|一律|永远(?:跟注|弃牌|加注)|每次都(?:跟注|弃牌|加注)/i;
const provisional =
  /\b(?:small|limited|sparse|early)\s+(?:pooled\s+)?(?:sample|evidence|observations?)\b|小样本|样本(?:有限|不足)|证据有限/i;
const conditional =
  /\b(?:if|when|facing|against|versus|vs|in position|out of position)\b|如果|当|面对|针对|有位置|无位置/i;
const numericClaim =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|quarter)\b[ -]*(?:percent|percentage|per cent|times|pot|bb|big blinds|chips)\b|[零一二三四五六七八九十百]+(?:成|倍|筹码|大盲|%)/i;

type VisibleExample = {
  observed?: {
    street?: string;
    seats?: Array<{ inHand?: boolean; folded?: boolean }>;
    effectiveStack?: number;
    bigBlind?: number;
    toCall?: number;
    pot?: number;
  };
  actualInput?: { heroPosition?: string };
};
function visibleExamples(batch: ResearchBatchV2): Map<string, VisibleExample[]> {
  const result = new Map<string, VisibleExample[]>();
  for (const example of batch.examples.filter((item) => item.phase === 'decision_visible')) {
    try {
      const parsed: unknown = JSON.parse(example.summary);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        result.set(example.handId, [
          ...(result.get(example.handId) ?? []),
          parsed as VisibleExample,
        ]);
    } catch {
      /* Unstructured historical examples cannot prove a narrow condition. */
    }
  }
  return result;
}

/** A bounded publication contract, not proof of strategic correctness or profitability. */
export function validateGuidanceProposal(
  proposal: ResearchProposalV2,
  batch: ResearchBatchV2,
): void {
  if (proposal.proposedRecipeId !== GUIDANCE_RECIPE_ID) return;
  if (proposal.kind !== 'opponent_brief' || batch.taskType !== 'opponent_brief')
    throw new Error('Guidance recipe applies only to opponent briefs');
  if (proposal.scope.opponentKeys.length !== 1 || proposal.scope.opponentKeys[0] !== batch.scopeKey)
    throw new Error('Guidance requires the researched opponent scope');
  const referenced = batch.examples.filter((item) => proposal.evidenceRefs.includes(item.id));
  const counterexamples = batch.examples.filter((item) =>
    proposal.counterEvidenceRefs.includes(item.id),
  );
  if (
    !counterexamples.length ||
    !counterexamples.some((counter) => referenced.some((item) => item.handId !== counter.handId))
  )
    throw new Error('Guidance requires an independently observed counterexample hand');
  if (!proposal.invalidateWhen.some((condition) => condition.kind === 'opponent_absent'))
    throw new Error('Guidance requires opponent absence invalidation');
  const text = [proposal.hypothesis, proposal.suggestedGuidance, ...proposal.limitations].join(' ');
  if (
    proposal.suggestedGuidance.split(/[;.!?\n]/).some((clause) => unconditional.test(clause)) ||
    /\b(?:call|fold|raise|bet|shove)\s+(?:any|every|all)\b/i.test(proposal.suggestedGuidance)
  )
    throw new Error('Unconditional action instruction is not guidance');
  if (certainty.test(text)) throw new Error('Unsupported hidden-card or behavioral certainty');
  if (numericClaim.test(text)) throw new Error('Numeric claims must use verified metricRefs');
  if (!conditional.test(proposal.suggestedGuidance))
    throw new Error('Guidance must state its decision condition');
  if (
    batch.eligibleHandIds.length < GUIDANCE_SMALL_SAMPLE_HANDS &&
    !proposal.limitations.some((limit) => provisional.test(limit))
  )
    throw new Error('Small-sample guidance requires an explicit limited-sample caveat');

  const metrics = batch.metrics.filter((metric) => proposal.metricRefs.includes(metric.id));
  if (!metrics.length || metrics.some((metric) => metric.opponentKey !== batch.scopeKey))
    throw new Error('Guidance requires verified opponent metrics');
  const visible = visibleExamples(batch);
  if (
    proposal.scope.streets.some(
      (street) => !metrics.some((metric) => metric.name.startsWith(`${street}_`)),
    )
  )
    throw new Error('Guidance street scope lacks a referenced street metric');
  // A table's capacity is not evidence that advice should apply only while every player is active.
  if (proposal.scope.players.length === 5) {
    if (!proposal.limitations.some((limit) => /\bpooled\b|合并样本|混合人数/i.test(limit)))
      throw new Error('Pooled player-count evidence requires an explicit limitation');
  } else {
    if (
      metrics.some((metric) =>
        metric.handIds.some((id) => {
          const examples = visible.get(id);
          return (
            !examples?.length ||
            examples.some(({ observed }) => {
              const seats = observed?.seats;
              return (
                !seats?.length ||
                seats.some((seat) => typeof seat.inHand !== 'boolean') ||
                !proposal.scope.players.includes(
                  seats.filter((seat) => seat.inHand && !seat.folded).length,
                )
              );
            })
          );
        }),
      )
    )
      throw new Error('Narrow active-player scope lacks fully stratified metric evidence');
  }
  const scope = proposal.scope;
  if (scope.positions.length || scope.stackBuckets.length || scope.betBuckets.length) {
    for (const metric of metrics)
      for (const handId of metric.handIds) {
        const examples = visible.get(handId);
        if (
          !examples?.length ||
          examples.some(({ observed, actualInput }) => {
            const position =
              actualInput?.heroPosition === 'BTN/SB' ? 'BTN' : actualInput?.heroPosition;
            const stack = observed?.effectiveStack,
              blind = observed?.bigBlind;
            const stackBb =
              typeof stack === 'number' && typeof blind === 'number' && blind > 0
                ? stack / blind
                : null;
            const stackBucket =
              stackBb === null ? null : stackBb < 40 ? 'short' : stackBb <= 100 ? 'medium' : 'deep';
            const call = observed?.toCall,
              pot = observed?.pot;
            const price =
              typeof call === 'number' && typeof pot === 'number' && pot > 0 ? call / pot : null;
            const betBucket =
              call === 0
                ? 'none'
                : price === null
                  ? null
                  : price <= 0.33
                    ? 'small'
                    : price <= 0.75
                      ? 'medium'
                      : 'large';
            return (
              (scope.positions.length && !scope.positions.some((value) => value === position)) ||
              (scope.stackBuckets.length &&
                !scope.stackBuckets.some((value) => value === stackBucket)) ||
              (scope.betBuckets.length && !scope.betBuckets.some((value) => value === betBucket))
            );
          })
        )
          throw new Error('Narrow decision scope lacks fully stratified metric evidence');
      }
  }
  const characters = [
    ...[
      proposal.hypothesis,
      proposal.suggestedGuidance,
      ...proposal.limitations,
      ...metrics.map((metric) => `${metric.name}: ${metric.numerator}/${metric.denominator}`),
    ].join(''),
  ].length;
  if (characters > ADVICE_LIMITS.itemCharacters)
    throw new Error('Guidance exceeds live advice character limit');
}
