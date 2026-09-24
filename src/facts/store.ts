import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditView, KnowledgeSnapshot } from '../knowledge/types.js';
import { POKER_RULES_VERSION, POKER_FEATURE_CONTRACT } from '../poker/domain.js';
import { connectionRevision } from '../storage/connection-revision.js';

export function factsHash(content: Omit<KnowledgeSnapshot, 'contentHash'>): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
export function emptyFactsSnapshot(): KnowledgeSnapshot {
  const content: Omit<KnowledgeSnapshot, 'contentHash'> = {
    version: 'poker-facts-empty-v1',
    source: 'baseline',
    rulesetVersion: POKER_RULES_VERSION,
    contextSchemaVersion: POKER_FEATURE_CONTRACT,
    evidenceEventId: 0,
    evidenceCutoff: '1970-01-01T00:00:00.000Z',
    publishedAt: '1970-01-01T00:00:00.000Z',
    expiresAt: null,
    opponents: [],
    cards: [],
    validation: ['No empirical evidence available; no strategy content.'],
  };
  return { ...content, contentHash: factsHash(content) };
}

/** Domain facts only. This validator does not import or permit any strategy publisher. */
export function validateFactsSnapshot(snapshot: KnowledgeSnapshot): void {
  const { contentHash, ...content } = snapshot;
  if (
    snapshot.cards.length !== 0 ||
    snapshot.rulesetVersion !== POKER_RULES_VERSION ||
    snapshot.contextSchemaVersion !== POKER_FEATURE_CONTRACT
  )
    throw new Error('Facts cannot contain strategies or incompatible schema');
  if (contentHash !== factsHash(content)) throw new Error('Facts content hash mismatch');
  const cutoff = Date.parse(snapshot.evidenceCutoff),
    published = Date.parse(snapshot.publishedAt);
  if (
    !Number.isFinite(cutoff) ||
    !Number.isFinite(published) ||
    cutoff > published ||
    snapshot.expiresAt !== null ||
    !Number.isSafeInteger(snapshot.evidenceEventId) ||
    snapshot.evidenceEventId < 0
  )
    throw new Error('Invalid facts cutoffs');
  if (snapshot.source === 'baseline') {
    if (snapshot.contentHash !== emptyFactsSnapshot().contentHash)
      throw new Error('Empty facts contain empirical evidence');
  } else if (snapshot.source !== 'deterministic' || snapshot.evidenceEventId === 0)
    throw new Error('Invalid facts source');
  if (
    snapshot.opponents.length > 256 ||
    new Set(snapshot.opponents.map((o) => o.name)).size !== snapshot.opponents.length
  )
    throw new Error('Invalid facts opponent window');
  for (const opponent of snapshot.opponents) {
    if (
      !opponent.name ||
      !Number.isSafeInteger(opponent.sampledHands) ||
      opponent.sampledHands < 1 ||
      opponent.sampledHands > 200 ||
      opponent.sampleLimit !== 200 ||
      !Number.isSafeInteger(opponent.shownHands) ||
      opponent.shownHands < 0 ||
      opponent.shownHands > opponent.sampledHands
    )
      throw new Error('Invalid facts sample counts');
    if (
      ![opponent.asOf, opponent.firstCompletedAt, opponent.lastCompletedAt].every((v) =>
        Number.isFinite(Date.parse(v)),
      ) ||
      Date.parse(opponent.asOf) > cutoff ||
      Date.parse(opponent.firstCompletedAt) > Date.parse(opponent.lastCompletedAt) ||
      Date.parse(opponent.lastCompletedAt) >= cutoff
    )
      throw new Error('Opponent facts exceed cutoff');
    for (const encounter of [...opponent.showdowns, ...opponent.recentEncountersWithHero]) {
      if (
        !Number.isSafeInteger(encounter.resultEventId) ||
        encounter.resultEventId < 1 ||
        encounter.resultEventId > snapshot.evidenceEventId ||
        ![encounter.completedAt, encounter.receivedAt].every(
          (v) => Number.isFinite(Date.parse(v)) && Date.parse(v) < cutoff,
        )
      )
        throw new Error('Future opponent facts');
    }
  }
}

export class FactsStore {
  readonly db: DatabaseSync;
  private cached?: { key: string; snapshot: KnowledgeSnapshot };
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) {
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
      return;
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts_snapshots(version TEXT PRIMARY KEY,watermark INTEGER NOT NULL UNIQUE,
        published_ms INTEGER NOT NULL,cutoff_ms INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS facts_publication ON facts_snapshots(published_ms,watermark);
      CREATE TABLE IF NOT EXISTS facts_decision_audits(decision_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,payload TEXT NOT NULL);`);
  }
  appendSnapshot(snapshot: KnowledgeSnapshot): boolean {
    validateFactsSnapshot(snapshot);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO facts_snapshots SELECT ?,?,?,?,?,?
         WHERE NOT EXISTS (SELECT 1 FROM facts_snapshots WHERE watermark>=? OR published_ms>?)`,
      )
      .run(
        snapshot.version,
        snapshot.evidenceEventId,
        Date.parse(snapshot.publishedAt),
        Date.parse(snapshot.evidenceCutoff),
        snapshot.contentHash,
        JSON.stringify(snapshot),
        snapshot.evidenceEventId,
        Date.parse(snapshot.publishedAt),
      );
    // Delayed or duplicate materialization cannot replace a newer admissible snapshot.
    return Number(result.changes) === 1;
  }
  latest(asOf = new Date().toISOString()): KnowledgeSnapshot {
    const cutoff = Date.parse(asOf);
    if (!Number.isFinite(cutoff)) return emptyFactsSnapshot();
    const row = this.db
      .prepare(
        'SELECT version,hash FROM facts_snapshots WHERE published_ms<=? AND cutoff_ms<=? ORDER BY watermark DESC LIMIT 1',
      )
      .get(cutoff, cutoff);
    if (!row) return emptyFactsSnapshot();
    const key = `${connectionRevision(this.db)}:${row.version}:${row.hash}`;
    if (this.cached?.key !== key) {
      const row_ = this.db
        .prepare('SELECT payload FROM facts_snapshots WHERE version=?')
        .get(String(row.version))!;
      const snapshot = JSON.parse(String(row_.payload)) as KnowledgeSnapshot;
      validateFactsSnapshot(snapshot);
      this.cached = { key, snapshot };
    }
    return structuredClone(this.cached.snapshot);
  }
  appendAudit(audit: AuditView): boolean {
    if (
      !audit.inputHash ||
      !audit.computedAt ||
      !Number.isFinite(Date.parse(audit.computedAt)) ||
      !['complete', 'unavailable'].includes(audit.status) ||
      audit.provenance !== 'asynchronous_audit_not_model_input'
    )
      throw new Error('Invalid immutable facts audit');
    return (
      Number(
        this.db
          .prepare('INSERT OR IGNORE INTO facts_decision_audits VALUES(?,?,?)')
          .run(audit.decisionId, audit.inputHash, JSON.stringify(audit)).changes,
      ) === 1
    );
  }
  getAudit(id: string): AuditView | null {
    const row = this.db
      .prepare('SELECT payload FROM facts_decision_audits WHERE decision_id=?')
      .get(id);
    return row ? (JSON.parse(String(row.payload)) as AuditView) : null;
  }
  cursor(key: string): number {
    return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? 0);
  }
  advance(key: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid facts cursor');
    this.db
      .prepare(
        'INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(meta.value AS INTEGER)<CAST(excluded.value AS INTEGER)',
      )
      .run(key, String(value));
  }
  close(): void {
    this.db.close();
  }
}
