import type { DecisionRecord } from 'duelloop';
import { percentile } from '../evaluation/async-research.js';
import type { ModelAttempt } from './model.js';
import type { ReplayPlan, ReplaySample } from './plan.js';

export interface ReplayResult {
  originalDecisionId: string;
  status: 'succeeded' | 'failed' | 'not_run';
  selected: string | null;
  originalChoice: string;
  matchesOriginal: boolean | null;
  tiedBestActions: string[];
  code: string | null;
  elapsedMs: number;
  decision: DecisionRecord | null;
}
export function replayResult(
  sample: ReplaySample,
  decision: DecisionRecord,
  elapsedMs: number,
): ReplayResult {
  const maximum = Math.max(...Object.values(decision.utilities));
  return {
    originalDecisionId: sample.decisionId,
    status: 'succeeded',
    selected: decision.action!.id,
    originalChoice: sample.originalChoice,
    matchesOriginal: decision.action!.id === sample.originalChoice,
    tiedBestActions: Object.entries(decision.utilities)
      .filter(([, value]) => value === maximum)
      .map(([key]) => key),
    code: null,
    elapsedMs,
    decision,
  };
}
export function summarizeReplay(plan: ReplayPlan, rows: ReplayResult[], attempts: ModelAttempt[]) {
  const succeeded = rows.filter((row) => row.status === 'succeeded');
  const knownUsage = attempts.reduce(
    (total, attempt) => ({
      inputTokens: total.inputTokens + (attempt.usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (attempt.usage.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  const latencies = (values: number[]) => ({
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  });
  return {
    schemaVersion: 'duelloop-poker-summary-v1',
    planHash: plan.planHash,
    experiment: 'posthoc_shadow_score_vs_recorded_choice',
    planned: plan.samples.length,
    succeeded: succeeded.length,
    failed: rows.filter((r) => r.status === 'failed').length,
    notRun: rows.filter((r) => r.status === 'not_run').length,
    originalChoiceMatches: succeeded.filter((r) => r.matchesOriginal).length,
    originalChoiceComparisons: succeeded.length,
    legalSelections: succeeded.filter((row) =>
      plan.samples
        .find((s) => s.decisionId === row.originalDecisionId)!
        .candidates.some((candidate) => candidate.id === row.selected),
    ).length,
    tiedDecisions: succeeded.filter((r) => r.tiedBestActions.length > 1).length,
    modelCalls: attempts.length,
    retries: attempts.filter((a) => a.retryIndex > 0).length,
    unknownUsageCalls: attempts.filter((a) => a.usage.unknown).length,
    knownUsage,
    modelKinds: [...new Set(succeeded.map((r) => r.decision?.modelKind))],
    actualModels: [...new Set(attempts.flatMap((a) => (a.actualModel ? [a.actualModel] : [])))],
    sourceModels: [...new Set(plan.samples.map((s) => s.originalModel))],
    archivedAdviceSamples: plan.samples.filter(
      (s) =>
        Array.isArray(s.request.state.approvedAdvice) && s.request.state.approvedAdvice.length > 0,
    ).length,
    streets: Object.fromEntries(
      ['preflop', 'flop', 'turn', 'river'].map((phase) => [
        phase,
        plan.samples.filter((s) => s.street === phase).length,
      ]),
    ),
    questions: succeeded.reduce((sum, row) => sum + row.decision!.questions.length, 0),
    latencyMs: {
      shadowSuccessfulDecisions: latencies(succeeded.map((row) => row.elapsedMs)),
      modelAttempts: latencies(attempts.map((attempt) => attempt.latencyMs)),
      recordedChoice: latencies(plan.samples.map((sample) => sample.originalLatencyMs)),
    },
    failureCodes: [...new Set(rows.flatMap((r) => (r.code ? [r.code] : [])))],
    limitations: [
      'Recorded Choice and fresh Score calls occurred at different times with different request contracts; this is not a randomized A/B test.',
      'Agreement is descriptive and does not establish decision correctness or profitability.',
      'Scores and normalized utilities are ordinal model outputs, not chip EV, poker equity or validated mixed-strategy frequencies.',
      'Original outcomes belong to the historical trajectory only; shadow actions have no observed reward.',
      'Source requests retain their original opponent evidence and any archived approved advice; no new LLM research or strategy publication occurred.',
      'Street-stratified sampling of eligible accepted actions excludes failures and incomplete source hands; it is not a population performance estimate.',
      'Usage summarizes terminal attempts when this report is written. Late usage is excluded and kept separately in late-results.jsonl; unknown usage is never treated as free.',
    ],
  };
}
export type ReplaySummary = ReturnType<typeof summarizeReplay>;
