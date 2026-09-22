import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(`Usage: node scripts/benchmark-advice-reads.mjs SOURCE.sqlite [--read-model COMPILED.js] [--as-of ISO_TIME]

Open SOURCE.sqlite read-only, freeze advice_metric_snapshots with one SELECT, then close it.
Copy the exact rows into an in-memory SQLite database and compare the old query with
AdviceReadModel.support(). Default module: dist/knowledge/advice-read-model.js.
No .env is loaded. No source database rows, indexes or configuration are changed.
Output contains counts/timings/equality only, never evidence payloads or credentials.
This is one RAM-only support-query comparison, not production service latency or P95.`);
  process.exit(args.length === 0 ? 1 : 0);
}
const sourcePath = args.shift();
let moduleUrl = new URL('../dist/knowledge/advice-read-model.js', import.meta.url);
let cutoff = Date.now();
while (args.length) {
  const flag = args.shift();
  const value = args.shift();
  if (flag === '--read-model' && value) moduleUrl = pathToFileURL(resolve(value));
  else if (flag === '--as-of' && value && Number.isFinite(Date.parse(value)))
    cutoff = Date.parse(value);
  else throw new Error('Invalid arguments; use --help for supported options.');
}
const { AdviceReadModel, migrateAdviceReadModel } = await import(moduleUrl.href);
const capturedAt = new Date().toISOString();
const source = new DatabaseSync(sourcePath, { readOnly: true });
let frozen;
try {
  source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
  // One statement owns one SQLite read snapshot, including the rowid tie-breaker.
  frozen = source
    .prepare(
      `SELECT rowid AS snapshot_rowid,id,scope_key,watermark,available_ms,payload
      FROM advice_metric_snapshots ORDER BY rowid`,
    )
    .all();
} finally {
  source.close();
}
const memory = new DatabaseSync(':memory:');
try {
  memory.exec(`
    CREATE TABLE advice_metric_snapshots (
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,watermark INTEGER NOT NULL,
      available_ms INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE advice_publications (
      seq INTEGER PRIMARY KEY,id TEXT UNIQUE,proposal_id TEXT,topic_key TEXT,
      revision INTEGER,available_ms INTEGER,payload TEXT);
    CREATE TABLE advice_audit (
      seq INTEGER PRIMARY KEY,at_ms INTEGER,action TEXT,subject_id TEXT,actor TEXT,details TEXT);
    BEGIN;
  `);
  const insert = memory.prepare(
    'INSERT INTO advice_metric_snapshots(rowid,id,scope_key,watermark,available_ms,payload) VALUES(?,?,?,?,?,?)',
  );
  for (const row of frozen)
    insert.run(
      row.snapshot_rowid,
      row.id,
      row.scope_key,
      row.watermark,
      row.available_ms,
      row.payload,
    );
  memory.exec('COMMIT');
  const oldStarted = performance.now();
  const previous = memory
    .prepare(
      `SELECT s.* FROM advice_metric_snapshots s
    WHERE s.available_ms<=? AND NOT EXISTS (SELECT 1 FROM advice_metric_snapshots newer
      WHERE newer.scope_key=s.scope_key AND newer.available_ms<=? AND
      (newer.watermark>s.watermark OR (newer.watermark=s.watermark AND newer.rowid>s.rowid)))
    ORDER BY s.watermark DESC LIMIT 64`,
    )
    .all(cutoff, cutoff);
  const oldMs = performance.now() - oldStarted;
  const migrationStarted = performance.now();
  migrateAdviceReadModel(memory);
  const migrationMs = performance.now() - migrationStarted;
  const model = new AdviceReadModel(memory);
  const nextStarted = performance.now();
  const next = model.support(cutoff);
  const newMs = performance.now() - nextStarted;
  const ids = (rows) => rows.map((row) => String(row.id)).sort();
  const identicalIds = JSON.stringify(ids(previous)) === JSON.stringify(ids(next));
  console.log(
    JSON.stringify(
      {
        kind: 'frozen-support-query-comparison',
        capturedAt,
        admissibleAt: new Date(cutoff).toISOString(),
        storage: 'in-memory SQLite; immutable source rows copied once',
        samplesPerQuery: 1,
        sourceRows: frozen.length,
        scopeCount: new Set(frozen.map((row) => row.scope_key)).size,
        oldMs,
        newMs,
        migrationMs,
        oldResultCount: previous.length,
        newResultCount: next.length,
        identicalIds,
        limitation:
          'Query-only RAM comparison; excludes HTTP, disk reads, JSON validation, bundle construction and contention; not service P95.',
      },
      null,
      2,
    ),
  );
  if (!identicalIds) process.exitCode = 2;
} finally {
  memory.close();
}
