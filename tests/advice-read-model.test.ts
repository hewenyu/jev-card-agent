import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdviceStore } from '../src/knowledge/advice-store.js';
import {
  AdviceReadModel,
  SUPPORT_ASOF_QUERY,
  SUPPORT_CURRENT_QUERY,
} from '../src/knowledge/advice-read-model.js';
import { contentHash, researchBatchHash } from '../src/knowledge/advice-validator.js';
import { publishFixture, researchFixture } from './helpers/research-fixture.js';

const stores: AdviceStore[] = [];
const dirs: string[] = [];
let time = Date.now();
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  time = Date.now();
});
function open(path = ':memory:', readOnly = false) {
  const store = new AdviceStore(path, { readOnly, clock: () => new Date(time) });
  stores.push(store);
  return store;
}
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'advice-index-'));
  dirs.push(dir);
  return join(dir, 'research.sqlite');
}
function options(at = time) {
  return {
    mode: 'live' as const,
    basePolicyVersion: researchFixture().batch.basePolicyVersion,
    admissibleAt: new Date(at).toISOString(),
  };
}
function evidence(store: AdviceStore, watermark: number, denominator: number) {
  const { batch } = researchFixture();
  batch.evidenceEventWatermark = watermark;
  batch.cutoff = new Date(time - 60 * 60_000).toISOString();
  batch.metrics[0]!.availableAt = new Date(time - 61 * 60_000).toISOString();
  batch.metrics[0]!.denominator = denominator;
  batch.sourceSnapshotHash = researchBatchHash(batch);
  store.refreshEvidence(batch);
}
function dropReadModel(store: AdviceStore) {
  store.db.exec(`
    DROP TRIGGER advice_support_read_insert;
    DROP TRIGGER advice_publication_read_insert;
    DROP TRIGGER advice_withdrawal_read_insert;
    DROP TABLE advice_support_refs;
    DROP TABLE advice_support_heads;
    DROP TABLE advice_read_boundaries;
    DROP TABLE advice_read_revision;
    DROP INDEX advice_publications_available;
  `);
}

describe('incremental advice read model', () => {
  it('preserves watermark order, arrival ties and historical availability', () => {
    const store = open();
    publishFixture(store);
    evidence(store, 20, 2);
    const initial = time;
    time += 1000;
    evidence(store, 10, 3); // late old evidence must never replace the head
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(2);
    time += 1000;
    evidence(store, 20, 4); // equal watermark: later arrival wins
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(4);
    expect(store.bundle(options(initial)).supportMetrics?.[0]?.denominator).toBe(2);
    expect(store.bundle(options(initial - 1)).publications).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM advice_metric_snapshots').get()!.n).toBe(3);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM advice_support_heads').get()!.n).toBe(1);
  });

  it('does not admit a future head into the current bundle', () => {
    const store = open();
    publishFixture(store);
    evidence(store, 20, 2);
    const { batch } = researchFixture();
    const metrics = [{ ...batch.metrics[0]!, denominator: 5 }];
    const future = time + 1000;
    store.db.prepare(`INSERT INTO advice_metric_snapshots VALUES(?,?,?,?,?)`).run(
      contentHash({ scopeKey: 'global', watermark: 30, metrics }),
      'global',
      30,
      future,
      JSON.stringify({
        metrics,
        receivedAt: new Date(future).toISOString(),
        cutoff: batch.cutoff,
      }),
    );
    const before = store.bundleRevision(options());
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(2);
    time = future;
    expect(store.bundleRevision(options())).not.toBe(before);
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(5);
  });

  it('migrates populated old databases once without changing history; readonly old databases work', () => {
    const file = path();
    const original = open(file);
    publishFixture(original);
    evidence(original, 20, 2);
    time += 1000;
    evidence(original, 10, 3);
    const history = original.db.prepare('SELECT rowid,* FROM advice_metric_snapshots').all();
    dropReadModel(original);
    const legacy = open(file, true);
    expect(legacy.bundle(options()).supportMetrics?.[0]?.denominator).toBe(2);
    const migrated = open(file);
    const token = migrated.bundleRevision(options());
    const again = open(file);
    expect(again.bundleRevision(options())).toBe(token);
    expect(again.bundle(options())).toEqual(legacy.bundle(options()));
    expect(again.db.prepare('SELECT rowid,* FROM advice_metric_snapshots').all()).toEqual(history);
    expect(again.db.prepare('SELECT COUNT(*) AS n FROM advice_support_refs').get()!.n).toBe(2);
    time += 1000;
    evidence(migrated, 30, 4);
    expect(legacy.bundle(options()).supportMetrics?.[0]?.denominator).toBe(4);
    expect(again.bundle(options()).supportMetrics?.[0]?.denominator).toBe(4);
  });

  it('reuses preparation until relevant writes or a validity boundary, without exposing mutable cache', () => {
    const store = open();
    const { publication } = publishFixture(store);
    evidence(store, 20, 2);
    const first = store.bundle(options());
    const token = store.bundleRevision(options());
    evidence(store, 20, 2); // Duplicate evidence is not a source change.
    expect(store.bundleRevision(options())).toBe(token);
    expect(() => {
      first.publications[0]!.guidance = 'caller mutation';
    }).toThrow(TypeError);
    const prepare = vi.spyOn(store.db, 'prepare');
    time += 100;
    expect(store.bundleRevision(options())).toBe(token);
    expect(store.bundle(options())).toBe(first);
    expect(store.bundle(options()).publications[0]!.guidance).toBe(publication.guidance);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('SELECT p.payload'))).toBe(false);
    prepare.mockRestore();
    evidence(store, 30, 3);
    expect(store.bundleRevision(options())).not.toBe(token);
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(3);
    const beforeExpiry = store.bundleRevision(options());
    time = Date.parse(publication.expiresAt);
    expect(store.bundleRevision(options())).not.toBe(beforeExpiry);
    expect(store.bundle(options()).publications).toHaveLength(0);
    expect(store.bundle(options(Date.parse(publication.availableAt))).publications).toHaveLength(1);
  });

  it('never reuses evidence from a rolled-back caller transaction with the same revision', () => {
    const store = open();
    publishFixture(store);
    store.db.exec('BEGIN');
    evidence(store, 20, 2);
    const rolledBackToken = store.bundleRevision(options());
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(2);
    store.db.exec('ROLLBACK');
    evidence(store, 20, 3);
    expect(store.bundleRevision(options())).toBe(rolledBackToken);
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(3);
    store.db.exec('BEGIN');
    evidence(store, 30, 4);
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(4);
    store.db.exec('ROLLBACK');
    expect(store.bundle(options()).supportMetrics?.[0]?.denominator).toBe(3);
  });

  it('observes cross-connection publication and withdrawal and preserves as-of replay', () => {
    const file = path();
    const writer = open(file);
    const reader = open(file, true);
    const token = reader.bundleRevision(options());
    expect(reader.bundle(options()).publications).toHaveLength(0);
    const { publication } = publishFixture(writer);
    expect(reader.bundleRevision(options())).not.toBe(token);
    const admitted = time;
    expect(reader.bundle(options()).publications).toHaveLength(1);
    time += 1000;
    writer.withdraw(publication.publicationId, { actor: 'operator', note: 'Review withdrawal' });
    expect(reader.bundle(options()).publications).toHaveLength(0);
    expect(reader.bundle(options(admitted)).publications).toHaveLength(1);
    expect(reader.bundle({ ...options(), mode: 'off' }).publications).toHaveLength(0);
  });

  it('uses one current pointer per scope and an indexed historical lookup, not nested history scans', () => {
    const store = open();
    store.db.exec('BEGIN');
    const insert = store.db.prepare('INSERT INTO advice_metric_snapshots VALUES(?,?,?,?,?)');
    for (let i = 0; i < 2043; i++) insert.run(`snapshot-${i}`, `scope-${i % 7}`, i, i, '{}');
    store.db.exec('COMMIT');
    expect(new AdviceReadModel(store.db).support(3000)).toHaveLength(7);
    expect(new AdviceReadModel(store.db).support(1000)).toHaveLength(7);
    const current = store.db.prepare(`EXPLAIN QUERY PLAN ${SUPPORT_CURRENT_QUERY}`).all();
    const historical = store.db.prepare(`EXPLAIN QUERY PLAN ${SUPPORT_ASOF_QUERY}`).all(1000);
    expect(current.map((row) => row.detail).join('\n')).toContain('USING INTEGER PRIMARY KEY');
    expect(historical.map((row) => row.detail).join('\n')).toContain(
      'USING COVERING INDEX advice_support_asof',
    );
    expect(historical.map((row) => row.detail).join('\n')).not.toContain('SCAN r');
  });
});
