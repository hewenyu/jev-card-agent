import { randomUUID } from 'node:crypto';
import type { ProviderAttempt, ProviderCall, ProviderMeter } from '../core/types.js';
import type { Store } from './store.js';

export interface MeterOptions {
  totalUsd?: number;
  runUsd?: number;
  reasoningInputPerMillion?: number;
  reasoningOutputPerMillion?: number;
}
/** Estimated cost ledger. Third-party proxy prices/added prompts require supplier reconciliation. */
export class LedgerMeter implements ProviderMeter {
  private readonly options: Required<MeterOptions>;
  constructor(
    private store: Store,
    private runId: string,
    options: MeterOptions = {},
  ) {
    this.options = {
      totalUsd: 9,
      runUsd: 1,
      reasoningInputPerMillion: 10,
      reasoningOutputPerMillion: 50,
      ...options,
    };
    for (const value of Object.values(this.options))
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid meter configuration');
    store.db.exec(`CREATE TABLE IF NOT EXISTS provider_usage (
      reservation_id TEXT PRIMARY KEY REFERENCES usage(id), attempt_id TEXT,
      provider TEXT NOT NULL, purpose TEXT NOT NULL, requested_model TEXT NOT NULL,
      actual_model TEXT, input_price REAL NOT NULL, output_price REAL NOT NULL,
      status TEXT NOT NULL, latency_ms REAL, error_code TEXT
    )`);
  }
  before(call: ProviderCall): string | null {
    if (call.inputCharacters > 48_000) return null;
    const inputPrice = call.provider === 'jev' ? 0.042 : this.options.reasoningInputPerMillion;
    const outputPrice = call.provider === 'jev' ? 0 : this.options.reasoningOutputPerMillion;
    // Jev has a published 64k input ceiling. Proxy input reservation is conservative but estimated.
    const inputTokens = call.provider === 'jev' ? 64_000 : call.inputCharacters * 4 + 16_384;
    const reserved = Math.ceil(
      (inputTokens * inputPrice + call.maxOutputTokens * outputPrice) * 1000,
    );
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const global = Number(
        db
          .prepare('SELECT COALESCE(SUM(COALESCE(charged_nanos,reserved_nanos)),0) AS n FROM usage')
          .get()?.n,
      );
      const run = Number(
        db
          .prepare(
            'SELECT COALESCE(SUM(COALESCE(charged_nanos,reserved_nanos)),0) AS n FROM usage WHERE run_id=?',
          )
          .get(this.runId)?.n,
      );
      if (
        global + reserved > this.options.totalUsd * 1e9 ||
        run + reserved > this.options.runUsd * 1e9
      ) {
        db.exec('ROLLBACK');
        return null;
      }
      const id = randomUUID();
      db.prepare(
        'INSERT INTO usage(id,run_id,reserved_nanos,status,created_at) VALUES(?,?,?,?,?)',
      ).run(id, this.runId, reserved, 'reserved', new Date().toISOString());
      db.prepare(
        `INSERT INTO provider_usage(reservation_id,provider,purpose,requested_model,input_price,output_price,status)
        VALUES(?,?,?,?,?,?,?)`,
      ).run(
        id,
        call.provider,
        call.purpose,
        call.requestedModel,
        inputPrice,
        outputPrice,
        'reserved',
      );
      db.exec('COMMIT');
      return id;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  after(attempt: ProviderAttempt, id: string): void {
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM provider_usage WHERE reservation_id=?').get(id);
      if (!row) throw new Error('Unknown provider reservation');
      if (row.status !== 'reserved') {
        db.exec('COMMIT');
        return;
      }
      if (attempt.usage) {
        const cost = Math.ceil(
          (attempt.usage.input_tokens * Number(row.input_price) +
            attempt.usage.output_tokens * Number(row.output_price)) *
            1000,
        );
        db.prepare(
          "UPDATE usage SET charged_nanos=?,input_tokens=?,output_tokens=?,status='settled' WHERE id=?",
        ).run(cost, attempt.usage.input_tokens, attempt.usage.output_tokens, id);
      } else db.prepare("UPDATE usage SET status='unknown' WHERE id=?").run(id);
      db.prepare(
        `UPDATE provider_usage SET attempt_id=?,actual_model=?,status=?,latency_ms=?,error_code=? WHERE reservation_id=?`,
      ).run(
        attempt.id,
        attempt.actualModel,
        attempt.status,
        attempt.latencyMs,
        attempt.errorCode ?? null,
        id,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
