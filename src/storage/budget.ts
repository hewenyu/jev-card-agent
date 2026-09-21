import { randomUUID } from 'node:crypto';
import type { Candidate, DecisionContext, Proposal } from '../core/types.js';
import type { BudgetPort } from '../runtime/types.js';
import type { Store } from './store.js';

export const INPUT_PRICE_PER_MILLION = 0.042;
const NANOS_PER_DOLLAR = 1_000_000_000;

export class Budget implements BudgetPort {
  private limits = new Map<string, number>();
  constructor(
    private store: Store,
    readonly totalUsd = 9,
    readonly runUsd = 1,
  ) {}
  setRunLimit(runId: string, dollars: number): void {
    this.limits.set(runId, dollars);
  }
  reserve(runId: string, context: DecisionContext, candidates: Candidate[]): string | null {
    // Reserve the provider's full documented 64k input context, not a guessed tokenizer ratio.
    // An input byte cap bounds our requests; actual usage reconciles this conservative reservation.
    if (Buffer.byteLength(JSON.stringify({ context, candidates })) > 48_000) return null;
    const reserved = Math.ceil(((64_000 * INPUT_PRICE_PER_MILLION) / 1_000_000) * NANOS_PER_DOLLAR);
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const total = Number(
        db
          .prepare('SELECT COALESCE(SUM(COALESCE(charged_nanos,reserved_nanos)),0) AS n FROM usage')
          .get()?.n,
      );
      const run = Number(
        db
          .prepare(
            'SELECT COALESCE(SUM(COALESCE(charged_nanos,reserved_nanos)),0) AS n FROM usage WHERE run_id=?',
          )
          .get(runId)?.n,
      );
      if (
        total + reserved > this.totalUsd * NANOS_PER_DOLLAR ||
        run + reserved > (this.limits.get(runId) ?? this.runUsd) * NANOS_PER_DOLLAR
      ) {
        db.exec('ROLLBACK');
        return null;
      }
      const id = randomUUID();
      db.prepare(
        'INSERT INTO usage(id,run_id,reserved_nanos,status,created_at) VALUES(?,?,?,?,?)',
      ).run(id, runId, reserved, 'reserved', new Date().toISOString());
      db.exec('COMMIT');
      return id;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  settle(id: string, proposal: Proposal | null): void {
    if (!proposal?.usage) {
      this.store.db
        .prepare("UPDATE usage SET status='unknown' WHERE id=? AND status='reserved'")
        .run(id);
      return;
    }
    const { input_tokens: input, output_tokens: output } = proposal.usage;
    const cost = Math.ceil(((input * INPUT_PRICE_PER_MILLION) / 1_000_000) * NANOS_PER_DOLLAR);
    this.store.db
      .prepare(
        `UPDATE usage SET charged_nanos=?,input_tokens=?,output_tokens=?,status='settled'
      WHERE id=? AND status IN ('reserved','unknown')`,
      )
      .run(cost, input, output, id);
  }
  summary(): { estimatedUsd: number; reservedUsd: number; unknownRequests: number } {
    const row = this.store.db
      .prepare(
        `SELECT COALESCE(SUM(charged_nanos),0) AS charged,
      COALESCE(SUM(CASE WHEN charged_nanos IS NULL THEN reserved_nanos ELSE 0 END),0) AS reserved,
      SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown FROM usage`,
      )
      .get();
    return {
      estimatedUsd: Number(row?.charged ?? 0) / NANOS_PER_DOLLAR,
      reservedUsd: Number(row?.reserved ?? 0) / NANOS_PER_DOLLAR,
      unknownRequests: Number(row?.unknown ?? 0),
    };
  }
}
