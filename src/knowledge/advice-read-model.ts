import type { DatabaseSync } from 'node:sqlite';

/** Small, replaceable indexes over immutable research evidence. No historical payload is changed. */
export function migrateAdviceReadModel(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='advice_read_revision'")
      .get();
    if (!exists) {
      db.exec(`
        CREATE TABLE advice_read_revision (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
          support_available_ms INTEGER NOT NULL);
        INSERT INTO advice_read_revision VALUES(1,1,0);
        CREATE TABLE advice_support_refs (
          snapshot_rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, scope_key TEXT NOT NULL,
          watermark INTEGER NOT NULL, available_ms INTEGER NOT NULL);
        CREATE INDEX advice_support_asof
          ON advice_support_refs(scope_key,watermark DESC,snapshot_rowid DESC,available_ms);
        CREATE TABLE advice_support_heads (
          scope_key TEXT PRIMARY KEY, snapshot_rowid INTEGER NOT NULL, watermark INTEGER NOT NULL);
        CREATE TABLE advice_read_boundaries (at_ms INTEGER PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS advice_publications_available ON advice_publications(available_ms);
        INSERT INTO advice_support_refs
          SELECT rowid,id,scope_key,watermark,available_ms FROM advice_metric_snapshots;
        INSERT INTO advice_support_heads
          SELECT scope_key,snapshot_rowid,watermark FROM (
            SELECT *,ROW_NUMBER() OVER (
              PARTITION BY scope_key ORDER BY watermark DESC,snapshot_rowid DESC) AS ranking
            FROM advice_support_refs) WHERE ranking=1;
        INSERT OR IGNORE INTO advice_read_boundaries SELECT available_ms FROM advice_metric_snapshots;
        INSERT OR IGNORE INTO advice_read_boundaries SELECT available_ms FROM advice_publications;
        INSERT OR IGNORE INTO advice_read_boundaries
          SELECT CAST(ROUND(unixepoch(json_extract(payload,'$.expiresAt'),'subsec')*1000) AS INTEGER)
          FROM advice_publications;
        INSERT OR IGNORE INTO advice_read_boundaries
          SELECT at_ms FROM advice_audit WHERE action='withdrawn';
        UPDATE advice_read_revision SET support_available_ms=
          COALESCE((SELECT MAX(available_ms) FROM advice_support_refs),0);
        CREATE TRIGGER advice_support_read_insert AFTER INSERT ON advice_metric_snapshots BEGIN
          INSERT INTO advice_support_refs VALUES(NEW.rowid,NEW.id,NEW.scope_key,NEW.watermark,NEW.available_ms);
          INSERT INTO advice_support_heads VALUES(NEW.scope_key,NEW.rowid,NEW.watermark)
            ON CONFLICT(scope_key) DO UPDATE SET
              snapshot_rowid=excluded.snapshot_rowid,watermark=excluded.watermark
            WHERE excluded.watermark>advice_support_heads.watermark OR
              (excluded.watermark=advice_support_heads.watermark AND
               excluded.snapshot_rowid>advice_support_heads.snapshot_rowid);
          INSERT OR IGNORE INTO advice_read_boundaries VALUES(NEW.available_ms);
          UPDATE advice_read_revision SET revision=revision+1,
            support_available_ms=MAX(support_available_ms,NEW.available_ms);
        END;
        CREATE TRIGGER advice_publication_read_insert AFTER INSERT ON advice_publications BEGIN
          INSERT OR IGNORE INTO advice_read_boundaries VALUES(NEW.available_ms);
          INSERT OR IGNORE INTO advice_read_boundaries VALUES(
            CAST(ROUND(unixepoch(json_extract(NEW.payload,'$.expiresAt'),'subsec')*1000) AS INTEGER));
          UPDATE advice_read_revision SET revision=revision+1;
        END;
        CREATE TRIGGER advice_withdrawal_read_insert AFTER INSERT ON advice_audit
          WHEN NEW.action='withdrawn' BEGIN
          INSERT OR IGNORE INTO advice_read_boundaries VALUES(NEW.at_ms);
          UPDATE advice_read_revision SET revision=revision+1;
        END;
      `);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const SUPPORT_CURRENT_QUERY = `SELECT s.* FROM advice_support_heads h
  JOIN advice_metric_snapshots s ON s.rowid=h.snapshot_rowid
  ORDER BY h.watermark DESC,h.scope_key LIMIT 64`;
export const SUPPORT_ASOF_QUERY = `SELECT s.* FROM advice_support_heads h
  JOIN advice_metric_snapshots s ON s.rowid=(
    SELECT r.snapshot_rowid FROM advice_support_refs r
    WHERE r.scope_key=h.scope_key AND r.available_ms<=?
    ORDER BY r.watermark DESC,r.snapshot_rowid DESC LIMIT 1)
  ORDER BY s.watermark DESC,h.scope_key LIMIT 64`;

export class AdviceReadModel {
  private readonly indexed: boolean;
  constructor(private readonly db: DatabaseSync) {
    this.indexed = Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='advice_read_revision'")
        .get(),
    );
  }
  /** Includes changes by other connections, and clock-only publication/expiry/withdrawal changes. */
  revision(at: number): string {
    if (this.indexed) {
      const row = this.db
        .prepare(
          `SELECT revision,
          (SELECT COALESCE(MAX(at_ms),0) FROM advice_read_boundaries WHERE at_ms<=?) AS boundary
          FROM advice_read_revision WHERE singleton=1`,
        )
        .get(at)!;
      return `${row.revision}:${row.boundary}`;
    }
    // A pre-migration read-only database cannot install indexes or triggers. Keep it correct;
    // a single pass is still preferable to the former quadratic correlated support query.
    const row = this.db
      .prepare(
        `SELECT MAX(at_ms) AS boundary FROM (
        SELECT available_ms AS at_ms FROM advice_metric_snapshots
        UNION ALL SELECT available_ms FROM advice_publications
        UNION ALL SELECT CAST(ROUND(unixepoch(json_extract(payload,'$.expiresAt'),'subsec')*1000) AS INTEGER)
          FROM advice_publications
        UNION ALL SELECT at_ms FROM advice_audit WHERE action='withdrawn') WHERE at_ms<=?`,
      )
      .get(at)!;
    const version = this.db.prepare('PRAGMA data_version').get()!.data_version;
    const changes = this.db.prepare('SELECT total_changes() AS value').get()!.value;
    return `legacy:${version}:${changes}:${row.boundary ?? 0}`;
  }
  support(at: number) {
    if (!this.indexed) {
      return this.db
        .prepare(
          `SELECT * FROM (
          SELECT *,ROW_NUMBER() OVER (
            PARTITION BY scope_key ORDER BY watermark DESC,rowid DESC) AS ranking
          FROM advice_metric_snapshots WHERE available_ms<=?)
          WHERE ranking=1 ORDER BY watermark DESC,scope_key LIMIT 64`,
        )
        .all(at);
    }
    const max = Number(
      this.db.prepare('SELECT support_available_ms FROM advice_read_revision').get()!
        .support_available_ms,
    );
    return at >= max
      ? this.db.prepare(SUPPORT_CURRENT_QUERY).all()
      : this.db.prepare(SUPPORT_ASOF_QUERY).all(at);
  }
}
