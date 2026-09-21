import type { Candidate, DecisionContext, Proposal } from '../core/types.js';
import { MAX_SESSION_ANALYSIS, type SessionTurn } from '../core/session.js';
import { json } from './database.js';
import type { Store } from './store.js';

/** Rebuild the same hand's advisory memory, including earlier runs after a reconnect. */
export function sessionTurns(
  store: Store,
  tableId: string,
  handId: string,
  asOf: string,
  beforeSeq: number,
): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const rows = store.db
    .prepare(
      'SELECT id,created_at,context,candidates,proposal,selected,status FROM decisions WHERE hand_id=? AND created_at<=? ORDER BY created_at,id',
    )
    .iterate(handId, asOf);
  for (const row of rows) {
    const context = json<DecisionContext>(row.context, {} as DecisionContext);
    if (
      context.tableId !== tableId ||
      context.handId !== handId ||
      !Number.isSafeInteger(context.lastTableSeq) ||
      context.lastTableSeq < 0 ||
      context.lastTableSeq >= beforeSeq
    )
      continue;
    const selected = json<Candidate[]>(row.candidates, []).find(
      (candidate) => candidate.id === row.selected,
    );
    const proposal = json<Partial<Proposal>>(row.proposal, {});
    const analysis =
      typeof proposal.routing?.analysis === 'string' ? proposal.routing.analysis : null;
    turns.push({
      decisionId: String(row.id),
      createdAt: String(row.created_at),
      tableSeq: context.lastTableSeq,
      street: context.street,
      status: String(row.status),
      action:
        selected && row.status !== 'cancelled'
          ? {
              kind: selected.action,
              ...(selected.amount === undefined ? {} : { raiseToChips: selected.amount }),
            }
          : null,
      analysis: analysis?.slice(0, MAX_SESSION_ANALYSIS) ?? null,
      analysisTruncated: (analysis?.length ?? 0) > MAX_SESSION_ANALYSIS,
    });
  }
  return turns.sort(
    (a, b) =>
      a.tableSeq - b.tableSeq ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.decisionId.localeCompare(b.decisionId),
  );
}
