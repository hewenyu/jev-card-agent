import {
  MAX_OUTCOME_DECISIONS,
  MAX_RECENT_OUTCOMES,
  type HistoricalDecision,
  type HistoricalOutcome,
} from '../core/history.js';
import type { Candidate, DecisionContext } from '../core/types.js';
import { json } from './database.js';
import type { Store } from './store.js';

function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function outcomeDecisions(
  store: Store,
  runId: string,
  handId: string,
  completedAt: string,
  asOf: string,
): HistoricalDecision[] {
  const decisions: HistoricalDecision[] = [];
  const rows = store.db
    .prepare(
      `SELECT * FROM decisions WHERE run_id=? AND hand_id=? AND status='accepted'
      AND created_at<=? AND created_at<? ORDER BY created_at DESC,id DESC`,
    )
    .iterate(runId, handId, completedAt, asOf);
  for (const row of rows) {
    const context = json<DecisionContext>(row.context, {} as DecisionContext);
    const candidates = json<Candidate[]>(row.candidates, []);
    const selected = candidates.find((candidate) => candidate.id === row.selected);
    if (!selected || (selected.amount !== undefined && !Number.isFinite(selected.amount))) continue;
    // Legacy contexts did not freeze a watermark. Recover only from evidence already
    // received for this exact run and hand; a later turn must never rewrite the past.
    const tableSeq = validSequence(context.lastTableSeq)
      ? context.lastTableSeq
      : store.db
          .prepare(
            `SELECT seq FROM events WHERE run_id=? AND hand_id=? AND type='your_turn'
            AND received_at<=? ORDER BY received_at DESC,id DESC LIMIT 1`,
          )
          .get(String(row.run_id), String(row.hand_id), String(row.created_at))?.seq;
    if (!validSequence(tableSeq)) continue;
    decisions.push({
      decisionId: String(row.id),
      decidedAt: String(row.created_at),
      tableSeq,
      street: context.street,
      board: context.board,
      holeCards: context.holeCards,
      action: selected.action,
      ...(selected.amount === undefined ? {} : { amount: selected.amount }),
    });
    // Match core ordering even when multiple turns share a clock timestamp.
    decisions.sort(
      (a, b) =>
        Date.parse(a.decidedAt) - Date.parse(b.decidedAt) ||
        a.tableSeq - b.tableSeq ||
        a.decisionId.localeCompare(b.decisionId),
    );
    // One extra valid decision lets the core report truncation truthfully.
    if (decisions.length > MAX_OUTCOME_DECISIONS + 1) decisions.shift();
  }
  return decisions;
}

/** Only settled real hands known before this decision may inform its historical feedback. */
export function recentOutcomes(
  store: Store,
  asOf: string,
  excludeHandId: string,
): HistoricalOutcome[] {
  const hands = store.db
    .prepare(
      `SELECT h.*,r.strategy FROM hands h JOIN runs r ON r.id=h.run_id
      WHERE r.mode='live' AND h.complete=1 AND h.profit IS NOT NULL AND h.big_blind>0
      AND h.ended_at<? AND h.id!=? ORDER BY h.ended_at DESC,h.id ASC LIMIT ?`,
    )
    .all(asOf, excludeHandId, MAX_RECENT_OUTCOMES);
  return hands.map((hand) => ({
    runId: String(hand.run_id),
    handId: String(hand.id),
    tableId: String(hand.table_id),
    strategy: String(hand.strategy),
    completedAt: String(hand.ended_at),
    verified: true,
    profitBb: Number(hand.profit) / Number(hand.big_blind),
    decisions: outcomeDecisions(
      store,
      String(hand.run_id),
      String(hand.id),
      String(hand.ended_at),
      asOf,
    ),
  }));
}
