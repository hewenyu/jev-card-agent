import { randomUUID } from 'node:crypto';
import { digest, type DecisionRecord, type Observation, type SqliteStore } from 'duelloop';
import type { DatabaseSync } from 'node:sqlite';

/** A turn can contain several cancelled attempts, but only one live model invocation at a time. */
export class DecisionAttempts {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sdk: SqliteStore,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS framework_decision_windows (
      context_id TEXT PRIMARY KEY, authority_deadline INTEGER NOT NULL, model_deadline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS framework_attempts (
      id TEXT PRIMARY KEY, context_id TEXT NOT NULL, after_event_id INTEGER NOT NULL,
      run_id TEXT NOT NULL, status TEXT NOT NULL, decision_id TEXT UNIQUE, sdk_event_id INTEGER);
      CREATE INDEX IF NOT EXISTS framework_attempt_context ON framework_attempts(context_id,after_event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS framework_attempt_running ON framework_attempts(context_id) WHERE status='running';`);
  }

  contextId(observation: Observation): string {
    return digest([observation.strategyScopeId, observation.streamId, observation.revision]);
  }

  authorityDeadline(observation: Observation): number {
    const row = this.db
      .prepare('SELECT authority_deadline FROM framework_decision_windows WHERE context_id=?')
      .get(this.contextId(observation));
    return Math.min(observation.deadline, row ? Number(row.authority_deadline) : Infinity);
  }

  window(observation: Observation, modelDeadline: number, previous?: DecisionRecord) {
    const id = this.contextId(observation);
    const authority = Math.min(observation.deadline, previous?.observation.deadline ?? Infinity);
    const model = Math.min(modelDeadline, previous?.modelDeadline ?? Infinity);
    this.db
      .prepare(
        `INSERT INTO framework_decision_windows VALUES(?,?,?)
      ON CONFLICT(context_id) DO UPDATE SET authority_deadline=MIN(authority_deadline,excluded.authority_deadline),
      model_deadline=MIN(model_deadline,excluded.model_deadline)`,
      )
      .run(id, authority, model);
    const row = this.db
      .prepare('SELECT * FROM framework_decision_windows WHERE context_id=?')
      .get(id)!;
    return {
      authorityDeadline: Number(row.authority_deadline),
      modelDeadline: Number(row.model_deadline),
    };
  }

  begin(observation: Observation, runId: string): string {
    const contextId = this.contextId(observation);
    if (
      this.db
        .prepare("SELECT 1 FROM framework_attempts WHERE context_id=? AND status='running'")
        .get(contextId)
    )
      throw new Error('Unfinished model attempt requires reconciliation');
    const id = randomUUID();
    const cursor = this.sdk.latestEvent(observation.strategyScopeId, 'decision')?.id ?? 0;
    this.db
      .prepare(
        "INSERT INTO framework_attempts(id,context_id,after_event_id,run_id,status) VALUES(?,?,?,?,'running')",
      )
      .run(id, contextId, cursor, runId);
    return id;
  }

  /** Called while replaying the SDK journal, so a crash before host projection loses no association. */
  attach(record: DecisionRecord, eventId: number): void {
    if (this.forDecision(record.decisionId)) return;
    const row = this.db
      .prepare(
        "SELECT id FROM framework_attempts WHERE context_id=? AND status='running' AND after_event_id<? ORDER BY rowid DESC LIMIT 1",
      )
      .get(this.contextId(record.observation), eventId);
    if (!row) return; // Older archives predate per-attempt IDs; their request projection remains readable.
    this.db
      .prepare(
        "UPDATE framework_attempts SET decision_id=?,sdk_event_id=?,status='recorded' WHERE id=?",
      )
      .run(record.decisionId, eventId, String(row.id));
    if (record.modelDeadline !== undefined)
      this.window(record.observation, record.modelDeadline, record);
  }

  forDecision(id: string) {
    return this.db.prepare('SELECT * FROM framework_attempts WHERE decision_id=?').get(id);
  }

  decisionId(id: string): string | undefined {
    const row = this.db.prepare('SELECT decision_id FROM framework_attempts WHERE id=?').get(id);
    return row?.decision_id ? String(row.decision_id) : undefined;
  }

  mayRetry(record: DecisionRecord): boolean {
    if (
      record.decisionSource !== 'stopped' ||
      record.stopReason !== 'CANCELLED' ||
      record.action ||
      this.sdk.intent(record.decisionId)
    )
      return false;
    const row = this.forDecision(record.decisionId);
    // The SDK emits this proof only for caller cancellation, never for a timeout or model failure.
    const proof = row?.sdk_event_id
      ? this.sdk.events({
          scopeId: record.observation.strategyScopeId,
          afterId: Number(row.sdk_event_id),
          types: ['decision.cancelled', 'runtime.stopped'],
          limit: 1,
        })[0]
      : this.sdk.latestEvent(record.observation.strategyScopeId, 'decision.cancelled');
    const data = proof?.data;
    return (
      proof?.type === 'decision.cancelled' &&
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.decisionId === record.decisionId
    );
  }

  callsContext(record: DecisionRecord): string {
    return String(this.forDecision(record.decisionId)?.id ?? this.contextId(record.observation));
  }
}
