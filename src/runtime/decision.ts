import { randomUUID } from 'node:crypto';
import { buildCandidates, buildContext, validateCandidate } from '../core/index.js';
import { chooseFallback } from '../policies/baseline.js';
import type { PokerState, Proposal, OpponentStats, ProviderAttempt } from '../core/types.js';
import { ProviderError } from '../policies/metering.js';
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
): Promise<{ decision: DecisionRecord; action: StoredAction } | null> {
  const candidates = buildCandidates(task.state);
  if (!candidates.length || !task.state.handId || !task.state.turnToken || !task.state.tableId)
    return null;
  const createdAt = new Date().toISOString();
  const context = buildContext(task.state, task.opponents, {
    asOf: createdAt,
    recentOutcomes: dependencies.store.recentOutcomes?.(createdAt, task.state.handId) ?? [],
  });
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
  const abort = () => callController.abort(task.controller.signal.reason);
  task.controller.signal.addEventListener('abort', abort, { once: true });
  const settle = (budget: BudgetPort | undefined, value: Proposal | null) => {
    if (budget && reservation !== null) {
      budget.settle(reservation, value);
      reservation = null;
    }
  };
  try {
    if (!fallbackReason && budgetMs > 0 && !task.controller.signal.aborted) {
      {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('decision_timeout'));
            callController.abort();
          }, budgetMs);
          callController.signal.addEventListener(
            'abort',
            () => reject(new Error('decision_cancelled')),
            { once: true },
          );
        });
        proposal = await Promise.race([
          dependencies.policy.decide(context, candidates, { signal: callController.signal }),
          timeout,
        ]);
        settle(dependencies.budget, proposal);
        const selected = candidates.find((candidate) => candidate.id === proposal?.candidateId);
        if (!selected || !validateCandidate(selected, task.state)) {
          proposal = null;
          fallbackReason = 'invalid_policy_candidate';
        }
      }
    }
  } catch (error) {
    if (error instanceof ProviderError && error.attempt) {
      failedAttempts.push(error.attempt);
      if (error.attempt.usage) {
        // Invalid model outputs can still incur a known charge. This object is only for billing.
        settle(dependencies.budget, {
          candidateId: candidates[0]!.id,
          selected: candidates[0]!.id,
          source: 'fallback',
          explanation: 'Provider failure with reported usage',
          latencyMs: error.attempt.latencyMs,
          usage: error.attempt.usage,
          attempts: failedAttempts,
        });
      }
    }
    fallbackReason = error instanceof Error ? error.message : 'policy_failed';
  } finally {
    if (timer) clearTimeout(timer);
    task.controller.signal.removeEventListener('abort', abort);
    settle(dependencies.budget, null);
  }
  if (task.controller.signal.aborted || Date.now() >= task.deadlineAt) return null;
  if (!proposal) {
    const candidate = chooseFallback(candidates);
    proposal = {
      candidateId: candidate.id,
      selected: candidate.id,
      source: 'fallback',
      explanation: 'Safe legal action selected by runtime fallback.',
      latencyMs: Date.now() - started,
      ...(failedAttempts.length ? { attempts: failedAttempts } : {}),
    };
    fallbackReason ??= 'insufficient_time';
  }
  const candidate = candidates.find((item) => item.id === proposal.candidateId);
  if (!candidate || !validateCandidate(candidate, task.state)) return null;
  const decision: DecisionRecord = {
    id: randomUUID(),
    runId,
    handId: task.state.handId,
    createdAt,
    context,
    candidates,
    proposal,
    fallbackReason,
  };
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
