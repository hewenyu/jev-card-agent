import { randomUUID } from 'node:crypto';
import { buildCandidates, buildContext, validateCandidate } from '../core/index.js';
import { chooseFallback } from '../policies/baseline.js';
import type { PokerState, Proposal, OpponentStats, ProviderAttempt } from '../core/types.js';
import { ProviderError, ProviderLedgerError } from '../policies/metering.js';
import { buildSession } from '../core/session.js';
import type { DecisionProgress } from '../core/types.js';
import type { LiveDecisionProgress } from '../shared/api.js';
import type { BudgetPort, DecisionRecord, RuntimeDependencies, StoredAction } from './types.js';

export interface DecisionTask {
  key: string;
  controller: AbortController;
  deadlineAt: number;
  state: PokerState;
  recovered: boolean;
  opponents: OpponentStats[];
}
export function authorityKey(state: PokerState): string {
  return `${state.handId ?? ''}:${state.turnToken ?? ''}`;
}
export async function decide(
  task: DecisionTask,
  dependencies: RuntimeDependencies,
  runId: string,
  budgetMs: number,
  onProgress?: (progress: LiveDecisionProgress) => void,
): Promise<{ decision: DecisionRecord; action: StoredAction | null } | null> {
  const candidates = buildCandidates(task.state);
  if (!candidates.length || !task.state.handId || !task.state.turnToken || !task.state.tableId)
    return null;
  const createdAt = new Date().toISOString();
  const decisionId = randomUUID();
  const context = buildContext(task.state, task.opponents, {
    asOf: createdAt,
    recentOutcomes: dependencies.store.recentOutcomes?.(createdAt, task.state.handId) ?? [],
  });
  context.session = buildSession(
    task.state.tableId,
    task.state.handId,
    decisionId,
    dependencies.store.sessionTurns?.(
      task.state.tableId,
      task.state.handId,
      createdAt,
      task.state.lastTableSeq,
    ) ?? [],
  );
  let analysisProgress: DecisionProgress | undefined;
  const progressAttempts = new Map<string, ProviderAttempt>();
  let frozen = false;
  let collectingOnly = false;
  const report = (progress: DecisionProgress | { phase: 'fallback' }) => {
    if (frozen) return;
    if (
      ('analysis' in progress && progress.analysis) ||
      ('thinking' in progress && progress.thinking)
    )
      analysisProgress = { ...analysisProgress, ...progress };
    if ('attempts' in progress)
      for (const attempt of progress.attempts ?? []) progressAttempts.set(attempt.id, attempt);
    if (collectingOnly || task.controller.signal.aborted) return;
    onProgress?.({
      id: decisionId,
      sessionId: context.session!.id,
      tableId: task.state.tableId!,
      handId: task.state.handId!,
      phase: progress.phase,
      startedAt: createdAt,
      updatedAt: new Date().toISOString(),
    });
  };
  const started = Date.now();
  let proposal: Proposal | null = null;
  const failedAttempts: ProviderAttempt[] = [];
  let fallbackReason: string | null = task.recovered
    ? 'recovered_turn_unknown_remaining_time'
    : null;
  let reservation: string | null = null;
  if (!fallbackReason && budgetMs > 0 && !task.controller.signal.aborted) {
    // Ledger failures must propagate to the runtime; they are not model failures.
    reservation = dependencies.budget?.reserve(runId, context, candidates) ?? null;
    if (dependencies.budget && reservation === null) fallbackReason = 'model_budget_exhausted';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callController = new AbortController();
  const abort = () => {
    collectingOnly = true;
    callController.abort(task.controller.signal.reason);
  };
  task.controller.signal.addEventListener('abort', abort, { once: true });
  const settle = (budget: BudgetPort | undefined, value: Proposal | null) => {
    if (budget && reservation !== null) {
      budget.settle(reservation, value);
      reservation = null;
    }
  };
  let policyCall: Promise<Proposal> | undefined;
  let policyError: unknown;
  try {
    if (!fallbackReason && budgetMs > 0 && !task.controller.signal.aborted) {
      {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('decision_timeout'));
            collectingOnly = true;
            callController.abort();
          }, budgetMs);
          callController.signal.addEventListener(
            'abort',
            () => reject(new Error('decision_cancelled')),
            { once: true },
          );
        });
        policyCall = dependencies.policy.decide(context, candidates, {
          signal: callController.signal,
          onProgress: report,
        });
        void policyCall.catch((error: unknown) => {
          policyError = error;
        });
        proposal = await Promise.race([policyCall, timeout]);
        settle(dependencies.budget, proposal);
        const selected = candidates.find((candidate) => candidate.id === proposal?.candidateId);
        if (!selected || !validateCandidate(selected, task.state)) {
          proposal = null;
          fallbackReason = 'invalid_policy_candidate';
        }
      }
    }
  } catch (error) {
    if (callController.signal.aborted && policyCall) {
      // Let cooperative cancellation publish its final attempt without delaying a legal submission.
      const graceMs = Math.max(0, Math.min(75, task.deadlineAt - Date.now() - 25));
      if (graceMs > 0) {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          policyCall.catch(() => undefined),
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, graceMs);
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
      }
    }
    if (error instanceof ProviderLedgerError || policyError instanceof ProviderLedgerError)
      throw policyError instanceof ProviderLedgerError ? policyError : error;
    const providerError = policyError instanceof ProviderError ? policyError : error;
    if (providerError instanceof ProviderError && providerError.attempt) {
      failedAttempts.push(...(providerError.attempts ?? [providerError.attempt]));
      if (providerError.attempt.usage) {
        // Invalid model outputs can still incur a known charge. This object is only for billing.
        settle(dependencies.budget, {
          candidateId: candidates[0]!.id,
          selected: candidates[0]!.id,
          source: 'fallback',
          explanation: 'Provider failure with reported usage',
          latencyMs: providerError.attempt.latencyMs,
          usage: providerError.attempt.usage,
          attempts: failedAttempts,
        });
      }
    }
    fallbackReason = providerError instanceof Error ? providerError.message : 'policy_failed';
  } finally {
    if (timer) clearTimeout(timer);
    task.controller.signal.removeEventListener('abort', abort);
    settle(dependencies.budget, null);
  }
  const cancelled = task.controller.signal.aborted || Date.now() >= task.deadlineAt;
  collectingOnly = cancelled;
  if (!proposal) {
    if (!cancelled) report({ phase: 'fallback' });
    const candidate = cancelled ? null : chooseFallback(candidates);
    proposal = {
      candidateId: candidate?.id ?? '',
      selected: candidate?.id ?? '',
      source: 'fallback',
      explanation: cancelled
        ? 'Decision cancelled; no action was submitted.'
        : 'Safe legal action selected by runtime fallback.',
      latencyMs: Date.now() - started,
      attempts: [
        ...new Map(
          [...progressAttempts.values(), ...failedAttempts].map((attempt) => [attempt.id, attempt]),
        ).values(),
      ],
      ...(analysisProgress
        ? {
            routing: {
              mode: 'hybrid',
              outcome: cancelled ? 'decision_cancelled' : 'runtime_fallback_after_analysis',
              analysis: analysisProgress.analysis,
              thinking: analysisProgress.thinking ?? null,
              thinkingSource: analysisProgress.thinkingSource ?? 'not_provided',
            },
          }
        : {}),
    };
    fallbackReason ??= 'insufficient_time';
  }
  frozen = true;
  const decision: DecisionRecord = {
    id: decisionId,
    runId,
    handId: task.state.handId,
    createdAt,
    context,
    candidates,
    proposal,
    fallbackReason: cancelled ? 'decision_cancelled' : fallbackReason,
    ...(cancelled ? { status: 'cancelled' as const } : {}),
  };
  if (cancelled) return { decision, action: null };
  const candidate = candidates.find((item) => item.id === proposal.candidateId);
  if (!candidate || !validateCandidate(candidate, task.state)) return null;
  const action: StoredAction = {
    id: randomUUID(),
    runId,
    decisionId: decision.id,
    tableId: task.state.tableId,
    status: 'prepared',
    createdAt: new Date().toISOString(),
    deadlineAt: task.deadlineAt,
    payload: {
      type: 'action',
      action: candidate.action,
      ...(candidate.action === 'raise' ? { amount: candidate.amount } : {}),
      hand_id: task.state.handId,
      turn_token: task.state.turnToken,
      client_action_id: '',
    },
  };
  action.payload.client_action_id = action.id;
  return { decision, action };
}
