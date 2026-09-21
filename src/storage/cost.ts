import type { Proposal } from '../core/types.js';
import type { Store } from './store.js';

/** Usage is an accounting record, never a permission to make another model request. */
export function usageSummary(store: Pick<Store, 'db'>) {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(charged_nanos),0) AS charged,
    COALESCE(SUM(CASE WHEN charged_nanos IS NULL THEN reserved_nanos ELSE 0 END),0) AS reserved,
    SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown FROM usage`,
    )
    .get();
  return {
    estimatedUsd: Number(row?.charged ?? 0) / 1e9,
    reservedUsd: Number(row?.reserved ?? 0) / 1e9,
    unknownRequests: Number(row?.unknown ?? 0),
  };
}

export function proposalCost(store: Store, proposal: Proposal): number {
  if (
    proposal.attempts?.length &&
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_usage'")
      .get()
  ) {
    const ids = proposal.attempts.map((attempt) => attempt.id);
    const row = store.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(u.charged_nanos,u.reserved_nanos)),0) AS cost
      FROM provider_usage p JOIN usage u ON u.id=p.reservation_id WHERE p.attempt_id IN (${ids.map(() => '?').join(',')})`,
      )
      .get(...ids);
    if (Number(row?.n) > 0) return Number(row?.cost) / 1e9;
  }
  return ((proposal.usage?.input_tokens ?? 0) * 0.042) / 1_000_000;
}
