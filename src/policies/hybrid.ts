import type {
  Candidate,
  DecisionContext,
  DecisionOptions,
  DecisionProgress,
  Policy,
  Proposal,
  ProviderAttempt,
} from '../core/types.js';
import type { RoutingJev } from './jev.js';
import type { ReasoningPolicy, ReasoningResult } from './reasoning.js';
import { ProviderError, ProviderLedgerError } from './metering.js';

export interface HybridConfig {
  jev: RoutingJev;
  reasoning: ReasoningPolicy;
  totalBudgetMs?: number;
  minimumReasoningBudgetMs?: number;
  reconsiderReserveMs?: number;
  reasoningMode?: 'always' | 'adaptive';
}
/** Reasoning is mandatory by default; Jev always owns the final discrete action. */
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
    const observed = new Map<string, ProviderAttempt>();
    const publish = options.onProgress;
    options = {
      ...options,
      onProgress: (progress: DecisionProgress) => {
        for (const attempt of progress.attempts ?? []) observed.set(attempt.id, attempt);
        publish?.({ ...progress, attempts: [...observed.values()] });
      },
    };
    const started = performance.now();
    const timeout = AbortSignal.timeout(this.totalBudgetMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    if ((this.config.reasoningMode ?? 'always') === 'always')
      return this.decideAlways(context, candidates, options, signal, started);
    options.onProgress?.({ phase: 'jev' });
    const initial = await this.config.jev.decideWithRouting(context, candidates, {
      signal,
      onProgress: options.onProgress,
    });
    signal.throwIfAborted();
    const attempts: ProviderAttempt[] = [...(initial.proposal.attempts ?? [])];
    const keep = (outcome: string, extra: Record<string, unknown> = {}): Proposal => {
      options.onProgress?.({ phase: 'completed', outcome, attempts: [...attempts] });
      return {
        ...initial.proposal,
        latencyMs: Math.round(performance.now() - started),
        attempts: [...attempts],
        routing: {
          ...initial.proposal.routing,
          mode: 'hybrid',
          reasoningMode: 'adaptive',
          outcome,
          ...extra,
        },
      };
    };
    if (!initial.needsReasoning) return keep('skipped_by_jev');
    const remaining = this.totalBudgetMs - (performance.now() - started);
    if (remaining < this.minimumReasoningBudgetMs + this.reconsiderReserveMs)
      return keep('insufficient_time');
    let completedAnalysis: Record<string, unknown> = {};
    try {
      options.onProgress?.({ phase: 'reasoning' });
      const analysisSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, Math.floor(remaining - this.reconsiderReserveMs))),
      ]);
      const analysis = await this.config.reasoning.analyze(context, candidates, {
        signal: analysisSignal,
        onProgress: options.onProgress,
      });
      attempts.push(...(analysis.attempts ?? [analysis.attempt]));
      completedAnalysis = {
        analysis: analysis.analysis,
        requestedModel: analysis.requestedModel,
        actualModel: analysis.actualModel,
        thinking: analysis.thinking ?? null,
        thinkingSource: analysis.thinkingSource ?? 'not_provided',
      };
      options.onProgress?.({ phase: 'reasoning', ...completedAnalysis, attempts: [...attempts] });
      signal.throwIfAborted();
      if (performance.now() - started >= this.totalBudgetMs - this.reconsiderReserveMs)
        return keep('insufficient_time_after_analysis', completedAnalysis);
      options.onProgress?.({
        phase: 'jev',
        analysis: analysis.analysis,
        thinking: analysis.thinking ?? null,
        thinkingSource: analysis.thinkingSource ?? 'not_provided',
        attempts: [...attempts],
      });
      const final = await this.config.jev.reconsider(context, candidates, analysis.analysis, {
        signal,
        onProgress: options.onProgress,
      });
      attempts.push(...(final.attempts ?? []));
      options.onProgress?.({ phase: 'jev', attempts: [...attempts] });
      signal.throwIfAborted();
      options.onProgress?.({
        phase: 'completed',
        outcome: 'reconsidered',
        ...completedAnalysis,
        attempts: [...attempts],
      });
      return {
        ...final,
        latencyMs: Math.round(performance.now() - started),
        attempts,
        routing: {
          ...initial.proposal.routing,
          ...final.routing,
          mode: 'hybrid',
          reasoningMode: 'adaptive',
          outcome: 'reconsidered',
          initialCandidateId: initial.proposal.candidateId,
          analysis: analysis.analysis,
          requestedModel: analysis.requestedModel,
          actualModel: analysis.actualModel,
          thinking: analysis.thinking ?? null,
          thinkingSource: analysis.thinkingSource ?? 'not_provided',
        },
      };
    } catch (error) {
      if (error instanceof ProviderLedgerError) throw error;
      if (error instanceof ProviderError)
        attempts.push(...(error.attempts ?? (error.attempt ? [error.attempt] : [])));
      options.onProgress?.({ phase: 'reasoning', attempts: [...attempts] });
      // A late result must never become actionable; the live runtime records failure without an action.
      signal.throwIfAborted();
      return keep('analysis_or_reconsider_failed', {
        ...completedAnalysis,
        errorCode: error instanceof ProviderError ? error.code : 'hybrid_provider_failed',
      });
    }
  }

  private async decideAlways(
    context: DecisionContext,
    candidates: Candidate[],
    options: DecisionOptions,
    signal: AbortSignal,
    started: number,
  ): Promise<Proposal> {
    const attempts: ProviderAttempt[] = [];
    let analysis: ReasoningResult | undefined;
    let errorCode: string | undefined;
    let partial: Record<string, unknown> = {};
    options.onProgress?.({ phase: 'reasoning' });
    try {
      const remaining = Math.floor(
        this.totalBudgetMs - (performance.now() - started) - this.reconsiderReserveMs,
      );
      if (remaining <= 0) throw new ProviderError('insufficient_time_for_reasoning');
      analysis = await this.config.reasoning.analyze(context, candidates, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
        onProgress: options.onProgress,
      });
      attempts.push(...(analysis.attempts ?? [analysis.attempt]));
    } catch (error) {
      if (error instanceof ProviderLedgerError) throw error;
      if (error instanceof ProviderError) {
        attempts.push(...(error.attempts ?? (error.attempt ? [error.attempt] : [])));
        const observed =
          [...attempts]
            .reverse()
            .find(
              (attempt) =>
                typeof attempt.diagnostics?.analysis === 'string' ||
                typeof attempt.diagnostics?.thinking === 'string',
            ) ?? error.attempt;
        const diagnostics = observed?.diagnostics;
        partial = {
          ...(typeof diagnostics?.analysis === 'string' ? { analysis: diagnostics.analysis } : {}),
          thinking: typeof diagnostics?.thinking === 'string' ? diagnostics.thinking : null,
          thinkingSource: diagnostics?.thinkingSource ?? 'not_provided',
          requestedModel: observed?.requestedModel,
          actualModel: observed?.actualModel,
        };
      }
      errorCode = error instanceof ProviderError ? error.code : 'hybrid_provider_failed';
    }
    options.onProgress?.({
      phase: 'reasoning',
      attempts: [...attempts],
      ...(analysis
        ? {
            analysis: analysis.analysis,
            thinking: analysis.thinking ?? null,
            thinkingSource: analysis.thinkingSource ?? 'not_provided',
          }
        : {}),
    });
    signal.throwIfAborted();
    options.onProgress?.({
      phase: 'jev',
      ...(analysis
        ? {
            analysis: analysis.analysis,
            thinking: analysis.thinking ?? null,
            thinkingSource: analysis.thinkingSource ?? 'not_provided',
          }
        : {}),
      attempts: [...attempts],
    });
    let final: Proposal;
    try {
      final = analysis
        ? await this.config.jev.reconsider(context, candidates, analysis.analysis, {
            signal,
            onProgress: options.onProgress,
          })
        : await this.config.jev.decide(context, candidates, {
            signal,
            onProgress: options.onProgress,
          });
    } catch (error) {
      if (error instanceof ProviderError)
        attempts.push(...(error.attempts ?? (error.attempt ? [error.attempt] : [])));
      options.onProgress?.({ phase: 'jev', attempts: [...attempts] });
      throw error;
    }
    attempts.push(...(final.attempts ?? []));
    options.onProgress?.({ phase: 'jev', attempts: [...attempts] });
    signal.throwIfAborted();
    const outcome = analysis ? 'reasoned_jev_final' : 'analysis_failed_jev_final';
    options.onProgress?.({ phase: 'completed', outcome, attempts: [...attempts] });
    return {
      ...final,
      latencyMs: Math.round(performance.now() - started),
      attempts,
      routing: {
        ...final.routing,
        mode: 'hybrid',
        reasoningMode: 'always',
        outcome,
        finalCandidateId: final.candidateId,
        analysis: analysis?.analysis ?? null,
        thinking: analysis?.thinking ?? null,
        thinkingSource: analysis?.thinkingSource ?? 'not_provided',
        ...(analysis
          ? { requestedModel: analysis.requestedModel, actualModel: analysis.actualModel }
          : partial),
        ...(errorCode ? { errorCode } : {}),
      },
    };
  }
}
