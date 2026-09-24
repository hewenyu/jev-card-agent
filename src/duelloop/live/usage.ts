import type { ModelAttempt, ModelAttemptStart, LateModelResult } from '../model.js';
import type { Store } from '../../storage/store.js';
import type { ProviderAttempt } from '../../core/types.js';
import { LedgerMeter } from '../../storage/provider-meter.js';
import { modelContextId } from './model.js';

export function providerAttempt(attempt: ModelAttempt, model: string): ProviderAttempt {
  const known =
    !attempt.usage.unknown &&
    attempt.usage.inputTokens !== undefined &&
    attempt.usage.outputTokens !== undefined;
  return {
    id: attempt.requestId,
    provider: 'jev',
    purpose: 'decision',
    requestedModel: model,
    actualModel: attempt.actualModel ?? null,
    retryIndex: attempt.retryIndex,
    maxRetries: 3,
    status:
      attempt.status === 'succeeded'
        ? 'succeeded'
        : attempt.code === 'CANCELLED'
          ? 'cancelled'
          : 'failed',
    usage: known
      ? { input_tokens: attempt.usage.inputTokens!, output_tokens: attempt.usage.outputTokens! }
      : null,
    latencyMs: attempt.latencyMs,
    ...(attempt.code ? { errorCode: attempt.code } : {}),
  };
}

export class LiveUsageLedger {
  private readonly meter: LedgerMeter;
  constructor(
    private readonly store: Store,
    readonly runId: string,
    readonly model: string,
  ) {
    this.meter = new LedgerMeter(store, runId);
    store.db.exec(`CREATE TABLE IF NOT EXISTS framework_calls (
      request_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, started TEXT NOT NULL,
      result TEXT, late_result TEXT);`);
    if (
      !store.db
        .prepare('PRAGMA table_info(framework_calls)')
        .all()
        .some((row) => row.name === 'context_id')
    )
      store.db.exec('ALTER TABLE framework_calls ADD COLUMN context_id TEXT');
    store.db.exec(
      'CREATE INDEX IF NOT EXISTS framework_calls_context ON framework_calls(context_id)',
    );
    // A new run is created only after acquiring the host lease and settling its predecessor.
    // An interrupted request may have reached the provider; its charge is unknown, never zero.
    store.assertRuntimeLease();
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db
        .prepare(
          "UPDATE provider_usage SET status='unknown',error_code='PROCESS_INTERRUPTED' WHERE status='reserved' AND reservation_id IN (SELECT u.id FROM usage u JOIN framework_calls c ON c.reservation_id=u.id WHERE u.run_id<>? AND c.result IS NULL)",
        )
        .run(runId);
      store.db
        .prepare(
          "UPDATE usage SET status='unknown' WHERE status='reserved' AND run_id<>? AND id IN (SELECT reservation_id FROM framework_calls WHERE result IS NULL)",
        )
        .run(runId);
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  }
  start = (attempt: ModelAttemptStart): void => {
    this.store.assertRuntimeLease();
    const reservation = this.meter.before(
      {
        provider: 'jev',
        purpose: 'decision',
        requestedModel: this.model,
        inputCharacters: 0,
        maxOutputTokens: 0,
      },
      (reservation) => {
        this.store.db
          .prepare(
            'INSERT INTO framework_calls(request_id,reservation_id,started,context_id) VALUES(?,?,?,?)',
          )
          .run(attempt.requestId, reservation, JSON.stringify(attempt), modelContextId() ?? null);
      },
    );
    if (!reservation) throw new Error('Cannot record model request');
  };
  finish = (attempt: ModelAttempt): void => {
    const row = this.store.db
      .prepare('SELECT reservation_id FROM framework_calls WHERE request_id=?')
      .get(attempt.requestId);
    if (!row) throw new Error('Model request has no durable start');
    this.meter.after(providerAttempt(attempt, this.model), String(row.reservation_id), () => {
      this.store.db
        .prepare('UPDATE framework_calls SET result=? WHERE request_id=?')
        .run(JSON.stringify(attempt), attempt.requestId);
    });
  };
  late = (attempt: LateModelResult): void => {
    this.store.db
      .prepare('UPDATE framework_calls SET late_result=? WHERE request_id=?')
      .run(JSON.stringify(attempt), attempt.requestId);
    const row = this.store.db
      .prepare('SELECT reservation_id FROM framework_calls WHERE request_id=?')
      .get(attempt.requestId);
    const usage = providerAttempt(attempt, this.model).usage;
    if (row && usage) {
      // Supplement unknown accounting only; the cancelled decision and request result stay immutable.
      const cost = Math.ceil(usage.input_tokens * 0.042 * 1000);
      this.store.db
        .prepare(
          "UPDATE usage SET status='settled',charged_nanos=?,input_tokens=?,output_tokens=? WHERE id=? AND status='unknown'",
        )
        .run(cost, usage.input_tokens, usage.output_tokens, String(row.reservation_id));
    }
  };
}
