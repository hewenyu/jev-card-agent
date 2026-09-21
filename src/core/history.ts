import type { Action, DecisionSource, Street } from './types.js';

export interface HistoricalDecision {
  decisionId: string;
  decidedAt: string;
  tableSeq: number;
  street: Street;
  /** Cards visible at this decision, never the final board added during settlement. */
  board: string[];
  holeCards: string[];
  action: Action;
  source: DecisionSource | 'unknown';
  fallbackReason: string | null;
  amount?: number;
}

export interface HistoricalOutcome {
  runId: string;
  strategy: string;
  handId: string;
  tableId: string | null;
  completedAt: string;
  verified: boolean;
  profitBb: number;
  decisions: HistoricalDecision[];
}

export interface RecentOutcome extends Omit<HistoricalOutcome, 'verified'> {
  decisionsTruncated: boolean;
}

export interface HistoricalFeedback {
  asOf: string;
  recentOutcomes?: HistoricalOutcome[];
}

export const MAX_RECENT_OUTCOMES = 10;
export const MAX_OUTCOME_DECISIONS = 8;

/** A bounded feedback view. Profit is an observed outcome, not a decision-quality label. */
export function summarizeRecentOutcomes(
  outcomes: HistoricalOutcome[],
  asOf: string,
  currentHandId: string | null,
): RecentOutcome[] {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) return [];
  const seenHands = new Set<string>();
  const summaries: RecentOutcome[] = [];
  const ordered = outcomes
    .filter(
      (outcome) =>
        outcome.verified &&
        outcome.handId !== currentHandId &&
        Number.isFinite(outcome.profitBb) &&
        Number.isFinite(Date.parse(outcome.completedAt)) &&
        Date.parse(outcome.completedAt) < cutoff,
    )
    .sort(
      (a, b) =>
        Date.parse(b.completedAt) - Date.parse(a.completedAt) ||
        a.handId.localeCompare(b.handId) ||
        a.runId.localeCompare(b.runId),
    );

  for (const outcome of ordered) {
    const key = JSON.stringify([outcome.tableId, outcome.handId]);
    if (seenHands.has(key)) continue;
    seenHands.add(key);
    const completed = Date.parse(outcome.completedAt);
    const seenDecisions = new Set<string>();
    const decisions = outcome.decisions
      .filter((decision) => {
        const at = Date.parse(decision.decidedAt);
        return (
          Number.isFinite(at) &&
          at <= completed &&
          at < cutoff &&
          Number.isSafeInteger(decision.tableSeq) &&
          decision.tableSeq >= 0 &&
          (decision.amount === undefined || Number.isFinite(decision.amount))
        );
      })
      .sort(
        (a, b) =>
          Date.parse(a.decidedAt) - Date.parse(b.decidedAt) ||
          a.tableSeq - b.tableSeq ||
          a.decisionId.localeCompare(b.decisionId),
      )
      .filter((decision) => {
        if (seenDecisions.has(decision.decisionId)) return false;
        seenDecisions.add(decision.decisionId);
        return true;
      });
    summaries.push({
      runId: outcome.runId,
      strategy: outcome.strategy,
      handId: outcome.handId,
      tableId: outcome.tableId,
      completedAt: outcome.completedAt,
      profitBb: outcome.profitBb,
      decisions: decisions.slice(-MAX_OUTCOME_DECISIONS).map((decision) => ({
        decisionId: decision.decisionId,
        decidedAt: decision.decidedAt,
        tableSeq: decision.tableSeq,
        street: decision.street,
        board: decision.board,
        holeCards: decision.holeCards,
        action: decision.action,
        source: decision.source ?? 'unknown',
        fallbackReason: decision.fallbackReason ?? null,
        ...(decision.amount === undefined ? {} : { amount: decision.amount }),
      })),
      decisionsTruncated: decisions.length > MAX_OUTCOME_DECISIONS,
    });
    if (summaries.length === MAX_RECENT_OUTCOMES) break;
  }
  return structuredClone(summaries);
}
