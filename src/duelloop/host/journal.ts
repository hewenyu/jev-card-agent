import { digest, type DecisionRecord, type ExecutionReceipt, type FeedbackEvent } from 'duelloop';
import type { DatabaseSync } from 'node:sqlite';

export type OutboxPayload =
  { kind: 'receipt'; value: ExecutionReceipt } | { kind: 'feedback'; value: FeedbackEvent };

/** Host tables live in the raw application DB, never in SDK-owned tables. */
export class HostJournal {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS framework_hands (
        scope TEXT NOT NULL, stream TEXT NOT NULL, actor TEXT NOT NULL, trajectory TEXT NOT NULL,
        facts_digest TEXT NOT NULL, facts TEXT NOT NULL, pinned_at TEXT NOT NULL, release TEXT,
        PRIMARY KEY(scope,stream,actor,trajectory));
      CREATE INDEX IF NOT EXISTS framework_hand_scope_time ON framework_hands(scope,pinned_at DESC);
      CREATE TABLE IF NOT EXISTS framework_decisions (
        decision_id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        run_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS framework_decision_identity ON framework_decisions(
        json_extract(payload,'$.observation.strategyScopeId'),
        json_extract(payload,'$.observation.streamId'), json_extract(payload,'$.observation.revision'));
      CREATE TABLE IF NOT EXISTS framework_execution (
        decision_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS framework_outbox (
        event_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE INDEX IF NOT EXISTS framework_outbox_pending ON framework_outbox(delivered,event_key);
      CREATE INDEX IF NOT EXISTS framework_outbox_pending_kind ON framework_outbox(delivered,kind);
      CREATE TABLE IF NOT EXISTS framework_cursors (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS framework_turns (
        authority TEXT PRIMARY KEY, table_id TEXT NOT NULL, received_at INTEGER NOT NULL,
        authority_deadline INTEGER NOT NULL, model_deadline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS framework_feedback (
        feedback_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS framework_migrations (
        version TEXT PRIMARY KEY, created_at TEXT NOT NULL, manifest TEXT NOT NULL);
    `);
    if (
      !db
        .prepare('PRAGMA table_info(framework_hands)')
        .all()
        .some((column) => column.name === 'expected_release')
    )
      db.exec('ALTER TABLE framework_hands ADD COLUMN expected_release TEXT');
    db.prepare('INSERT OR IGNORE INTO framework_migrations VALUES(?,?,?)').run(
      'host-bridge-v1',
      new Date().toISOString(),
      JSON.stringify({ additive: true, legacyHistory: 'preserved' }),
    );
  }

  atomic<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT framework_host');
    try {
      const result = operation();
      this.db.exec('RELEASE framework_host');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO framework_host; RELEASE framework_host');
      throw error;
    }
  }

  decision(record: DecisionRecord, runId?: string): void {
    const hash = digest(record);
    const prior = this.db
      .prepare('SELECT digest FROM framework_decisions WHERE decision_id=?')
      .get(record.decisionId);
    if (prior && prior.digest !== hash) throw new Error('Framework decision identity conflict');
    this.db
      .prepare('INSERT OR IGNORE INTO framework_decisions VALUES(?,?,?,?,?)')
      .run(
        record.decisionId,
        hash,
        JSON.stringify(record),
        runId ?? null,
        new Date(record.finishedAt).toISOString(),
      );
  }

  getDecision(id: string): DecisionRecord | undefined {
    const row = this.db
      .prepare('SELECT payload FROM framework_decisions WHERE decision_id=?')
      .get(id);
    return row ? (JSON.parse(String(row.payload)) as DecisionRecord) : undefined;
  }

  enqueue(key: string, payload: OutboxPayload): void {
    const hash = digest(payload);
    const old = this.db.prepare('SELECT digest FROM framework_outbox WHERE event_key=?').get(key);
    if (old && old.digest !== hash) throw new Error('Framework outbox event identity conflict');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO framework_outbox(event_key,kind,payload,digest) VALUES(?,?,?,?)',
      )
      .run(key, payload.kind, JSON.stringify(payload), hash);
  }

  pending(kind?: OutboxPayload['kind']) {
    return this.db
      .prepare(
        `SELECT event_key,payload FROM framework_outbox WHERE delivered=0 ${kind ? 'AND kind=?' : ''} ORDER BY rowid LIMIT 100`,
      )
      .all(...(kind ? [kind] : []))
      .map((row) => ({
        key: String(row.event_key),
        payload: JSON.parse(String(row.payload)) as OutboxPayload,
      }));
  }

  delivered(key: string): void {
    this.db
      .prepare(
        'UPDATE framework_outbox SET delivered=1,attempts=attempts+1,error=NULL WHERE event_key=?',
      )
      .run(key);
  }

  failed(key: string): void {
    this.db
      .prepare(
        "UPDATE framework_outbox SET attempts=attempts+1,error='delivery_failed' WHERE event_key=?",
      )
      .run(key);
  }

  cursor(key: string): number {
    return Number(
      this.db.prepare('SELECT value FROM framework_cursors WHERE key=?').get(key)?.value ?? 0,
    );
  }

  advance(key: string, value: number): void {
    this.db
      .prepare(
        'INSERT INTO framework_cursors VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)',
      )
      .run(key, value);
  }
}
