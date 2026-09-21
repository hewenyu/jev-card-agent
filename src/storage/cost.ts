import type { Proposal } from '../core/types.js';
import type { Store } from './store.js';

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
