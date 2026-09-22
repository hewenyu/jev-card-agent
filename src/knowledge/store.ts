import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BASE_CARDS } from './selector.js';
import {
  KNOWLEDGE_CONTEXT_VERSION,
  RULESET_VERSION,
  KnowledgeValidator,
  snapshotHash,
} from './validator.js';
import type { AuditView, KnowledgeSnapshot } from './types.js';

export function baselineSnapshot(): KnowledgeSnapshot {
  const content: Omit<KnowledgeSnapshot, 'contentHash'> = {
    version: 'poker-knowledge-base-v1',
    source: 'baseline',
    rulesetVersion: RULESET_VERSION,
    contextSchemaVersion: KNOWLEDGE_CONTEXT_VERSION,
    evidenceEventId: 0,
    evidenceCutoff: '1970-01-01T00:00:00.000Z',
    publishedAt: '1970-01-01T00:00:00.000Z',
    expiresAt: null,
    opponents: [],
    cards: structuredClone(BASE_CARDS),
    validation: ['Static reviewed strategy references; no empirical opponent claims.'],
  };
  return { ...content, contentHash: snapshotHash(content) };
}
export class KnowledgeStore {
  readonly db: DatabaseSync;
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) {
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
      return;
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_versions (
        version TEXT PRIMARY KEY, watermark INTEGER NOT NULL UNIQUE, published_ms INTEGER NOT NULL,
        hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_publication ON knowledge_versions(published_ms,watermark);
      CREATE TABLE IF NOT EXISTS decision_audits (
        decision_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, payload TEXT NOT NULL);
    `);
  }
  publish(snapshot: KnowledgeSnapshot): boolean {
    new KnowledgeValidator().validate(snapshot);
    const current = this.latest();
    if (
      snapshot.evidenceEventId <= current.evidenceEventId ||
      Date.parse(snapshot.publishedAt) < Date.parse(current.publishedAt)
    )
      return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_versions(version,watermark,published_ms,hash,payload)
      SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM knowledge_versions WHERE watermark>=? OR published_ms>?)`,
      )
      .run(
        snapshot.version,
        snapshot.evidenceEventId,
        Date.parse(snapshot.publishedAt),
        snapshot.contentHash,
        JSON.stringify(snapshot),
        snapshot.evidenceEventId,
        Date.parse(snapshot.publishedAt),
      );
    return Number(result.changes) === 1;
  }
  latest(asOf = new Date().toISOString()): KnowledgeSnapshot {
    const row = this.db
      .prepare(
        'SELECT payload FROM knowledge_versions WHERE published_ms<=? ORDER BY watermark DESC LIMIT 1',
      )
      .get(Date.parse(asOf));
    const snapshot = row
      ? (JSON.parse(String(row.payload)) as KnowledgeSnapshot)
      : baselineSnapshot();
    new KnowledgeValidator().validate(snapshot);
    return snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= Date.parse(asOf)
      ? baselineSnapshot()
      : snapshot;
  }
  get(version: string): KnowledgeSnapshot | null {
    if (version === baselineSnapshot().version) return baselineSnapshot();
    const row = this.db
      .prepare('SELECT payload FROM knowledge_versions WHERE version=?')
      .get(version);
    return row ? (JSON.parse(String(row.payload)) as KnowledgeSnapshot) : null;
  }
  appendAudit(audit: AuditView): boolean {
    if (
      !audit.inputHash ||
      !audit.computedAt ||
      !Number.isFinite(Date.parse(audit.computedAt)) ||
      !['complete', 'unavailable'].includes(audit.status)
    )
      throw new Error('Only completed immutable audit additions can be stored');
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO decision_audits(decision_id,input_hash,payload) VALUES(?,?,?)',
      )
      .run(audit.decisionId, audit.inputHash, JSON.stringify(audit));
    return Number(result.changes) === 1;
  }
  getAudit(decisionId: string): AuditView | null {
    const row = this.db
      .prepare('SELECT payload FROM decision_audits WHERE decision_id=?')
      .get(decisionId);
    return row ? (JSON.parse(String(row.payload)) as AuditView) : null;
  }
  cursor(key: string): number {
    return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? 0);
  }
  advance(key: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(meta.value AS INTEGER)<CAST(excluded.value AS INTEGER)`,
      )
      .run(key, String(value));
  }
  close(): void {
    this.db.close();
  }
}
