import { randomUUID } from 'node:crypto';
import type { Candidate, DecisionContext, Policy, Proposal } from '../core/types.js';
import { BaselinePolicy } from '../policies/baseline.js';
import { ProviderError } from '../policies/metering.js';
import type { EvaluationView, StrategyName } from '../shared/api.js';
import { Queries } from '../storage/queries.js';
import type { Store } from '../storage/store.js';
import { proposalCost } from '../storage/cost.js';

/** Frozen, actor-visible snapshots only. Alternate actions never inherit historical payoffs. */
export async function evaluateRun(
  store: Store,
  runId: string,
  strategy: StrategyName,
  limit = 20,
  policy?: Policy,
  options: { id?: string; timeoutMs?: number } = {},
): Promise<EvaluationView> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Evaluation limit must be 1–100');
  const queries = new Queries(store);
  if (!queries.runs().some((run) => run.id === runId)) throw new Error('Run not found');
  if (strategy === 'jev' && !policy) throw new Error('Jev evaluation requires a metered provider');
  if (strategy === 'jev-reasoning' && !policy)
    throw new Error('Combined evaluation requires a metered provider');
  const selected = policy ?? new BaselinePolicy();
  const snapshots = queries.decisions(runId, limit);
  if (!snapshots.length) throw new Error('This run has no decision snapshots');
  const result: EvaluationView = {
    id: options.id ?? randomUUID(),
    createdAt: new Date().toISOString(),
    sourceRunId: runId,
    strategy,
    samples: 0,
    agreements: 0,
    errors: 0,
    costUsd: 0,
    meanLatencyMs: 0,
    rows: [],
  };
  let totalLatency = 0;
  for (const decision of snapshots) {
    const context = structuredClone(decision.context) as unknown as DecisionContext;
    const candidates: Candidate[] = decision.candidates.map((c) => ({
      id: c.id,
      label: c.label,
      action: c.action.kind as Candidate['action'],
      ...(c.action.raiseToChips === undefined ? {} : { amount: c.action.raiseToChips }),
    }));
    let proposal: Proposal | null = null;
    const started = performance.now();
    try {
      proposal = await selected.decide(context, candidates, {
        signal: AbortSignal.timeout(
          options.timeoutMs ?? (strategy === 'jev-reasoning' ? 15000 : 40000),
        ),
      });
      if (!candidates.some((c) => c.id === proposal!.candidateId))
        throw new Error('Policy returned an unknown candidate');
      if (proposal.candidateId === decision.selectedCandidateId) result.agreements++;
      result.costUsd += proposalCost(store, proposal);
      result.rows.push({
        decisionId: decision.id,
        original: decision.selectedCandidateId,
        alternative: proposal.candidateId,
        status: 'compared',
      });
    } catch (error) {
      if (error instanceof ProviderError && error.attempt) {
        proposal = {
          candidateId: '',
          selected: '',
          source: 'unavailable',
          explanation: error.code,
          latencyMs: error.attempt.latencyMs,
          model: error.attempt.actualModel ?? undefined,
          usage: error.attempt.usage ?? undefined,
          attempts: error.attempts ?? [error.attempt],
        };
        result.costUsd += proposalCost(store, proposal);
      }
      result.errors++;
      result.rows.push({
        decisionId: decision.id,
        original: decision.selectedCandidateId,
        alternative: null,
        status: error instanceof Error ? error.message : 'Evaluation failed',
      });
    }
    result.samples++;
    totalLatency += performance.now() - started;
  }
  result.meanLatencyMs = totalLatency / result.samples;
  const ledger = store.db
    .prepare(
      `SELECT SUM(COALESCE(charged_nanos,reserved_nanos))/1e9 AS cost
    FROM usage WHERE run_id=?`,
    )
    .get(`evaluation-${result.id}`);
  if (ledger?.cost != null) result.costUsd = Number(ledger.cost);
  queries.saveEvaluation(result);
  return result;
}
