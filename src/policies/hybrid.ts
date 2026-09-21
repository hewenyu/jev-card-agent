import type {
  Candidate,
  DecisionContext,
  DecisionOptions,
  Policy,
  Proposal,
  ProviderAttempt,
} from '../core/types.js';
import type { RoutingJev } from './jev.js';
import type { ReasoningPolicy } from './reasoning.js';
import { ProviderError } from './metering.js';

export interface HybridConfig {
  jev: RoutingJev;
  reasoning: ReasoningPolicy;
  totalBudgetMs?: number;
  minimumReasoningBudgetMs?: number;
  reconsiderReserveMs?: number;
}
/** Jev controls both the optional analysis route and the final discrete action. */
export class HybridPolicy implements Policy {
  private readonly totalBudgetMs: number;
  private readonly minimumReasoningBudgetMs: number;
  private readonly reconsiderReserveMs: number;
  constructor(private readonly config: HybridConfig) {
    this.totalBudgetMs = config.totalBudgetMs ?? 15000;
    this.minimumReasoningBudgetMs = config.minimumReasoningBudgetMs ?? 2000;
    this.reconsiderReserveMs = config.reconsiderReserveMs ?? 3000;
    for (const value of [
      this.totalBudgetMs,
      this.minimumReasoningBudgetMs,
      this.reconsiderReserveMs,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error('Hybrid budgets must be positive integer milliseconds');
  }
  async decide(
    context: DecisionContext,
    candidates: Candidate[],
    options: DecisionOptions = {},
  ): Promise<Proposal> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(this.totalBudgetMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const initial = await this.config.jev.decideWithRouting(context, candidates, { signal });
    signal.throwIfAborted();
    const attempts: ProviderAttempt[] = [...(initial.proposal.attempts ?? [])];
    const keep = (outcome: string, extra: Record<string, unknown> = {}): Proposal => ({
      ...initial.proposal,
      latencyMs: Math.round(performance.now() - started),
      attempts: [...attempts],
      routing: { ...initial.proposal.routing, mode: 'hybrid', outcome, ...extra },
    });
    if (!initial.needsReasoning) return keep('skipped_by_jev');
    const remaining = this.totalBudgetMs - (performance.now() - started);
    if (remaining < this.minimumReasoningBudgetMs + this.reconsiderReserveMs)
      return keep('insufficient_time');
    let completedAnalysis: Record<string, unknown> = {};
    try {
      const analysisSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, Math.floor(remaining - this.reconsiderReserveMs))),
      ]);
      const analysis = await this.config.reasoning.analyze(context, candidates, {
        signal: analysisSignal,
      });
      attempts.push(analysis.attempt);
      completedAnalysis = {
        analysis: analysis.analysis,
        requestedModel: analysis.requestedModel,
        actualModel: analysis.actualModel,
      };
      signal.throwIfAborted();
      if (performance.now() - started >= this.totalBudgetMs - this.reconsiderReserveMs)
        return keep('insufficient_time_after_analysis', {
          analysis: analysis.analysis,
          actualModel: analysis.actualModel,
        });
      const final = await this.config.jev.reconsider(context, candidates, analysis.analysis, {
        signal,
      });
      attempts.push(...(final.attempts ?? []));
      signal.throwIfAborted();
      return {
        ...final,
        latencyMs: Math.round(performance.now() - started),
        attempts,
        routing: {
          ...initial.proposal.routing,
          mode: 'hybrid',
          outcome: 'reconsidered',
          initialCandidateId: initial.proposal.candidateId,
          analysis: analysis.analysis,
          requestedModel: analysis.requestedModel,
          actualModel: analysis.actualModel,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError && error.attempt) attempts.push(error.attempt);
      // A late result must never become an actionable proposal; runtime chooses any safe fallback.
      signal.throwIfAborted();
      return keep('analysis_or_reconsider_failed', {
        ...completedAnalysis,
        errorCode: error instanceof ProviderError ? error.code : 'hybrid_provider_failed',
      });
    }
  }
}
