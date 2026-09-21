import { randomUUID } from 'node:crypto';
import type { ProviderAttempt, ProviderCall, ProviderMeter } from '../core/types.js';
import type { Store } from './store.js';

export interface MeterOptions {
  reasoningInputPerMillion?: number;
  reasoningCacheReadInputPerMillion?: number;
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
      reasoningInputPerMillion: 10,
      reasoningOutputPerMillion: 50,
      ...options,
      reasoningCacheReadInputPerMillion:
        options.reasoningCacheReadInputPerMillion ?? options.reasoningInputPerMillion ?? 10,
    };
    for (const value of Object.values(this.options))
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid meter configuration');
    store.db.exec(`CREATE TABLE IF NOT EXISTS provider_usage (
      reservation_id TEXT PRIMARY KEY REFERENCES usage(id), attempt_id TEXT,
      provider TEXT NOT NULL, purpose TEXT NOT NULL, requested_model TEXT NOT NULL,
      actual_model TEXT, input_price REAL NOT NULL, output_price REAL NOT NULL,
      status TEXT NOT NULL, latency_ms REAL, error_code TEXT
    )`);
    const columns = new Set(
      store.db
        .prepare('PRAGMA table_info(provider_usage)')
        .all()
        .map((row) => row.name),
    );
    for (const [name, type] of [
      ['cache_read_input_price', 'REAL'],
      ['cache_read_input_tokens', 'INTEGER'],
      ['cache_creation_input_tokens', 'INTEGER'],
    ])
      if (!columns.has(name))
        store.db.exec(`ALTER TABLE provider_usage ADD COLUMN ${name} ${type}`);
  }
  before(call: ProviderCall): string | null {
    if (call.inputCharacters > 48_000) return null;
    const inputPrice = call.provider === 'jev' ? 0.042 : this.options.reasoningInputPerMillion;
    const cacheReadPrice =
      call.provider === 'jev' ? inputPrice : this.options.reasoningCacheReadInputPerMillion;
    const outputPrice = call.provider === 'jev' ? 0 : this.options.reasoningOutputPerMillion;
    // Jev has a published 64k input ceiling. Proxy input reservation is conservative but estimated.
    const inputTokens = call.provider === 'jev' ? 64_000 : call.inputCharacters * 4 + 16_384;
    const reserved = Math.ceil(
      (inputTokens * Math.max(inputPrice, cacheReadPrice) + call.maxOutputTokens * outputPrice) *
        1000,
    );
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO usage(id,run_id,reserved_nanos,status,created_at) VALUES(?,?,?,?,?)',
      ).run(id, this.runId, reserved, 'reserved', new Date().toISOString());
      db.prepare(
        `INSERT INTO provider_usage(reservation_id,provider,purpose,requested_model,input_price,output_price,status,cache_read_input_price)
        VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        call.provider,
        call.purpose,
        call.requestedModel,
        inputPrice,
        outputPrice,
        'reserved',
        cacheReadPrice,
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
        const cached = attempt.usage.cache_read_input_tokens ?? 0;
        if (cached > attempt.usage.input_tokens)
          throw new Error('Cached input exceeds total input');
        const cost = Math.ceil(
          ((attempt.usage.input_tokens - cached) * Number(row.input_price) +
            cached * Number(row.cache_read_input_price ?? row.input_price) +
            attempt.usage.output_tokens * Number(row.output_price)) *
            1000,
        );
        db.prepare(
          "UPDATE usage SET charged_nanos=?,input_tokens=?,output_tokens=?,status='settled' WHERE id=?",
        ).run(cost, attempt.usage.input_tokens, attempt.usage.output_tokens, id);
      } else db.prepare("UPDATE usage SET status='unknown' WHERE id=?").run(id);
      db.prepare(
        `UPDATE provider_usage SET attempt_id=?,actual_model=?,status=?,latency_ms=?,error_code=?,cache_read_input_tokens=?,cache_creation_input_tokens=? WHERE reservation_id=?`,
      ).run(
        attempt.id,
        attempt.actualModel,
        attempt.status,
        attempt.latencyMs,
        attempt.errorCode ?? null,
        attempt.usage?.cache_read_input_tokens ?? null,
        attempt.usage?.cache_creation_input_tokens ?? null,
        id,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
