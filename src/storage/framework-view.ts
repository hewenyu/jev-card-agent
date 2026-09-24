import type { Proposal } from '../core/types.js';
import type { FrameworkDecisionView } from '../shared/framework.js';

/** Decode new SDK decisions explicitly; legacy Choice records remain unchanged. */
export function frameworkDecisionView(
  proposal: Partial<Proposal>,
): FrameworkDecisionView | undefined {
  const source = proposal.framework;
  if (source?.schema !== 'duelloop-score-v1') return undefined;
  const record = source.decision;
  const u = record.usage;
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return {
    decisionId: record.decisionId,
    releaseDigest: record.releaseDigest,
    strategyDigest: record.strategyDigest,
    factsSnapshotDigest: source.factsSnapshotDigest,
    selection: source.selection ?? 'argmax',
    branchId: record.branchId ?? null,
    scores: record.questions.flatMap((question) => {
      const answer = record.answers[question.id];
      return answer
        ? [
            {
              candidateId: question.actionId,
              dimensionId: question.dimensionId,
              score: answer.score,
              confidence: valid(answer.confidence) ? answer.confidence : null,
              levels: question.criteria.length,
            },
          ]
        : [];
    }),
    utilities: { ...record.utilities },
    selectionProbabilities: { ...record.probabilities },
    usage: {
      inputTokens: valid(u?.inputTokens) ? u.inputTokens : null,
      outputTokens: valid(u?.outputTokens) ? u.outputTokens : null,
      tokensComplete: !!u && !u.unknown && valid(u.inputTokens) && valid(u.outputTokens),
      costUsd: valid(u?.costUsd) && !u?.costUnknown ? u.costUsd : null,
      costComplete: valid(u?.costUsd) && !u?.costUnknown,
    },
    modelDeadline: record.modelDeadline ? new Date(record.modelDeadline).toISOString() : null,
  };
}
