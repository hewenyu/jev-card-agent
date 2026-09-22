import type { DatabaseSync } from 'node:sqlite';

const sources = ['runs', 'hands', 'decisions', 'usage', 'funding_events'] as const;
type Source = (typeof sources)[number];
const columns: Record<Source, readonly string[]> = {
  runs: ['id', 'mode', 'strategy', 'model', 'status', 'started_at', 'ended_at', 'reason'],
  hands: [
    'id',
    'run_id',
    'table_id',
    'hand_number',
    'board',
    'hero_cards',
    'profit',
    'big_blind',
    'status',
    'started_at',
    'ended_at',
    'complete',
  ],
  decisions: ['id', 'run_id', 'latency_ms', 'source', 'status', 'cost_usd'],
  usage: ['run_id', 'reserved_nanos', 'charged_nanos'],
  funding_events: [
    'id',
    'run_id',
    'created_at',
    'kind',
    'source',
    'available_after',
    'chips_at_table',
    'season_score',
    'score_source',
    'season_id',
  ],
};
const initialized = new WeakSet<DatabaseSync>();
const readSnapshots = new WeakSet<DatabaseSync>();
const caches = new WeakMap<DatabaseSync, Map<string, { revision: string; value: unknown }>>();
const MAX_ENTRIES = 128;

/** Persistent revisions also observe writes made by another connection or process. */
export function initializeReadCache(db: DatabaseSync): void {
  if (initialized.has(db)) return;
  // Do not mark DDL installed until it can survive a caller-owned transaction rollback.
  if (db.isTransaction) return;
  db.exec(`CREATE TABLE IF NOT EXISTS read_revisions (
    source TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
  )`);
  for (const source of sources) {
    db.prepare('INSERT OR IGNORE INTO read_revisions(source) VALUES(?)').run(source);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const changed = columns[source]
        .map((column) => `NEW.${column} IS NOT OLD.${column}`)
        .join(' OR ');
      db.exec(`CREATE TRIGGER IF NOT EXISTS read_revision_${source}_${operation.toLowerCase()}
        AFTER ${operation}${operation === 'UPDATE' ? ` OF ${columns[source].join(',')}` : ''} ON ${source}
        ${operation === 'UPDATE' ? `WHEN ${changed}` : ''} BEGIN
          UPDATE read_revisions SET revision=revision+1 WHERE source='${source}';
        END`);
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS funding_events_run_time
    ON funding_events(run_id,created_at);
    CREATE INDEX IF NOT EXISTS funding_events_run_kind_time
    ON funding_events(run_id,kind,created_at);`);
  initialized.add(db);
}

/** All components of a read use the same committed SQLite snapshot. */
export function readSnapshot<T>(db: DatabaseSync, read: () => T): T {
  if (db.isTransaction) return read();
  db.exec('BEGIN DEFERRED');
  readSnapshots.add(db);
  try {
    const result = read();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    caches.delete(db);
    throw error;
  } finally {
    readSnapshots.delete(db);
  }
}

/** Recompute once per source revision, not once per viewer or wall-clock interval. */
export function cachedRead<T>(
  db: DatabaseSync,
  key: string,
  dependencies: readonly Source[],
  compute: () => T,
): T {
  // Uncommitted revisions may be reused after rollback. Never cache caller-owned writes.
  if (db.isTransaction && !readSnapshots.has(db)) return compute();
  initializeReadCache(db);
  return readSnapshot(db, () => cachedSnapshot(db, key, dependencies, compute));
}

function cachedSnapshot<T>(
  db: DatabaseSync,
  key: string,
  dependencies: readonly Source[],
  compute: () => T,
): T {
  const revisions = new Map(
    db
      .prepare('SELECT source,revision FROM read_revisions')
      .all()
      .map((row) => [String(row.source), row.revision]),
  );
  const revision = dependencies.map((source) => `${source}:${revisions.get(source)}`).join('|');
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const previous = cache.get(key);
  if (previous?.revision === revision) return structuredClone(previous.value) as T;
  const value = compute();
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { revision, value: structuredClone(value) });
  return value;
}
