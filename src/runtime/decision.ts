import { randomUUID } from 'node:crypto';
import { buildCandidates, buildContext, validateCandidate } from '../core/index.js';
import { chooseFallback } from '../policies/baseline.js';
import type { PokerState, Proposal, OpponentStats, ProviderAttempt } from '../core/types.js';
import { ProviderError, ProviderLedgerError } from '../policies/metering.js';
import { buildSession } from '../core/session.js';
import type { DecisionProgress } from '../core/types.js';
import type { LiveDecisionProgress } from '../shared/api.js';
import type { DecisionRecord, RuntimeDependencies, StoredAction } from './types.js';

export interface DecisionTask {
  key: string;
  controller: AbortController;
  deadlineAt: number;
  state: PokerState;
  recovered: boolean;
  recoveryDeadlineKnown?: boolean;
  requireJev?: boolean;
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
  if (!task.state.handId || !task.state.turnToken || !task.state.tableId) return null;
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
  context.opponentMemory = dependencies.store.getOpponentMemory?.(task.state, createdAt) ?? [];
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
  let rejectedProposal: Proposal | null = null;
  const requireJev = task.requireJev !== false;
  const failedAttempts: ProviderAttempt[] = [];
  let fallbackReason: string | null = !candidates.length
    ? 'no_legal_candidates'
    : task.recovered && !task.recoveryDeadlineKnown
      ? 'recovered_turn_unknown_remaining_time'
      : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callController = new AbortController();
  const abort = () => {
    collectingOnly = true;
    callController.abort(task.controller.signal.reason);
  };
  task.controller.signal.addEventListener('abort', abort, { once: true });
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
        const selected = candidates.find((candidate) => candidate.id === proposal?.candidateId);
        if (
          !selected ||
          !validateCandidate(selected, task.state) ||
          (requireJev && proposal.source !== 'jev')
        ) {
          rejectedProposal = proposal;
          fallbackReason =
            requireJev && proposal.source !== 'jev'
              ? 'non_jev_policy_proposal'
              : 'invalid_policy_candidate';
          proposal = null;
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
    if (
      !requireJev &&
      (error instanceof ProviderLedgerError || policyError instanceof ProviderLedgerError)
    )
      throw policyError instanceof ProviderLedgerError ? policyError : error;
    const providerError = policyError instanceof ProviderError ? policyError : error;
    if (providerError instanceof ProviderError && providerError.attempt) {
      failedAttempts.push(...(providerError.attempts ?? [providerError.attempt]));
    }
    fallbackReason = providerError instanceof Error ? providerError.message : 'policy_failed';
  } finally {
    if (timer) clearTimeout(timer);
    task.controller.signal.removeEventListener('abort', abort);
  }
  const cancelled = task.controller.signal.aborted;
  if (!cancelled && Date.now() >= task.deadlineAt) {
    rejectedProposal = proposal;
    proposal = null;
    fallbackReason = 'decision_deadline_elapsed';
  }
  collectingOnly = cancelled;
  if (!proposal) {
    if (!cancelled && !requireJev) report({ phase: 'fallback' });
    const candidate = cancelled || requireJev ? null : chooseFallback(candidates);
    proposal = {
      ...rejectedProposal,
      candidateId: candidate?.id ?? '',
      selected: candidate?.id ?? '',
      source: requireJev ? 'unavailable' : 'fallback',
      explanation: cancelled
        ? 'Decision cancelled; no action was submitted.'
        : requireJev
          ? 'Jev decision unavailable; no action was submitted.'
          : 'Safe legal action selected by runtime fallback.',
      latencyMs: Date.now() - started,
      attempts: [
        ...new Map(
          [
            ...(rejectedProposal?.attempts ?? []),
            ...progressAttempts.values(),
            ...failedAttempts,
          ].map((attempt) => [attempt.id, attempt]),
        ).values(),
      ],
      ...(analysisProgress
        ? {
            routing: {
              mode: 'hybrid',
              outcome: cancelled
                ? 'decision_cancelled'
                : requireJev
                  ? 'model_decision_failed'
                  : 'runtime_fallback_after_analysis',
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
    ...(cancelled
      ? { status: 'cancelled' as const }
      : requireJev && fallbackReason
        ? { status: 'failed' as const }
        : {}),
  };
  if (cancelled || decision.status === 'failed') return { decision, action: null };
  const candidate = candidates.find((item) => item.id === proposal.candidateId);
  if (!candidate || !validateCandidate(candidate, task.state)) return null;
  const action: StoredAction = {
    decisionSource: proposal.source,
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
