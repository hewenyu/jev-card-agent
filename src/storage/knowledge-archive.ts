import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AdviceBundle, AsyncLlmMode } from '../knowledge/advice-types.js';
import { validateAdviceBundle } from '../knowledge/advice-validator.js';
import { KnowledgeValidator } from '../knowledge/validator.js';
import type { KnowledgeSnapshot } from '../knowledge/types.js';

export const MAX_KNOWLEDGE_ARCHIVE_BYTES = 16 * 1024 * 1024;

export class KnowledgeIntegrityError extends Error {
  constructor(detail: string) {
    super(`knowledge_integrity: ${detail}`);
    this.name = 'KnowledgeIntegrityError';
  }
}
export interface ArchivedKnowledge {
  schemaVersion: 'combined-knowledge-v2';
  bundleHash: string;
  snapshot: KnowledgeSnapshot;
  advice: AdviceBundle;
}
export interface AvailableKnowledge {
  archive: ArchivedKnowledge;
  availableAt: string;
  publicationSeq?: number;
}
export function combinedHash(content: Omit<ArchivedKnowledge, 'bundleHash'>): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
export function initializeKnowledgeArchives(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_archives (
    bundle_hash TEXT PRIMARY KEY, mode TEXT NOT NULL, available_at TEXT NOT NULL,
    payload TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS knowledge_archive_available ON knowledge_archives(mode,available_at);
    CREATE TABLE IF NOT EXISTS knowledge_archive_publications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, available_at TEXT NOT NULL,
      bundle_hash TEXT NOT NULL REFERENCES knowledge_archives(bundle_hash)
    );`);
}
export function verifyArchive(raw: unknown): ArchivedKnowledge {
  try {
    const archive = raw as ArchivedKnowledge;
    if (archive.schemaVersion !== 'combined-knowledge-v2')
      throw new Error('Unknown archive schema');
    const { bundleHash, ...content } = archive;
    if (bundleHash !== combinedHash(content)) throw new Error('Combined bundle hash mismatch');
    new KnowledgeValidator().validate(archive.snapshot);
    validateAdviceBundle(archive.advice);
    return archive;
  } catch (error) {
    throw new KnowledgeIntegrityError(error instanceof Error ? error.message : 'Invalid archive');
  }
}
/** Archive commit must finish before hand_knowledge can reference this content hash. */
export function archiveKnowledge(
  db: DatabaseSync,
  snapshot: KnowledgeSnapshot,
  advice: AdviceBundle,
  availableAt: string,
): AvailableKnowledge {
  const content = { schemaVersion: 'combined-knowledge-v2' as const, snapshot, advice };
  const archive = verifyArchive({ ...content, bundleHash: combinedHash(content) });
  const at = Date.parse(availableAt);
  if (
    !Number.isFinite(at) ||
    Date.parse(snapshot.publishedAt) > at ||
    Date.parse(advice.availableAt) > at
  )
    throw new KnowledgeIntegrityError('Archive availability precedes its contents');
  if (Buffer.byteLength(JSON.stringify(archive), 'utf8') > MAX_KNOWLEDGE_ARCHIVE_BYTES)
    throw new KnowledgeIntegrityError('Knowledge archive exceeds bounded cache limit');
  db.prepare(
    'INSERT OR IGNORE INTO knowledge_archives(bundle_hash,mode,available_at,payload) VALUES(?,?,?,?)',
  ).run(archive.bundleHash, advice.mode, availableAt, JSON.stringify(archive));
  const prior = db
    .prepare(
      'SELECT bundle_hash,available_at,seq FROM knowledge_archive_publications WHERE mode=? ORDER BY seq DESC LIMIT 1',
    )
    .get(advice.mode);
  if (prior && String(prior.bundle_hash) === archive.bundleHash)
    return {
      ...readArchive(db, archive.bundleHash),
      availableAt: String(prior.available_at),
      publicationSeq: Number(prior.seq),
    };
  const publication = db
    .prepare(
      'INSERT INTO knowledge_archive_publications(mode,available_at,bundle_hash) VALUES(?,?,?)',
    )
    .run(advice.mode, availableAt, archive.bundleHash);
  return {
    ...readArchive(db, archive.bundleHash),
    availableAt,
    publicationSeq: Number(publication.lastInsertRowid),
  };
}
export function readArchive(db: DatabaseSync, hash: string): AvailableKnowledge {
  const row = db
    .prepare('SELECT payload,available_at FROM knowledge_archives WHERE bundle_hash=?')
    .get(hash);
  if (!row) throw new KnowledgeIntegrityError('Referenced immutable archive is missing');
  if (Buffer.byteLength(String(row.payload), 'utf8') > MAX_KNOWLEDGE_ARCHIVE_BYTES)
    throw new KnowledgeIntegrityError('Oversized archive');
  let archive: ArchivedKnowledge;
  try {
    archive = verifyArchive(JSON.parse(String(row.payload)));
  } catch (error) {
    throw error instanceof KnowledgeIntegrityError
      ? error
      : new KnowledgeIntegrityError('Unreadable archive');
  }
  if (
    archive.bundleHash !== hash ||
    !Number.isFinite(Date.parse(String(row.available_at))) ||
    Date.parse(archive.snapshot.publishedAt) > Date.parse(String(row.available_at)) ||
    Date.parse(archive.advice.availableAt) > Date.parse(String(row.available_at))
  )
    throw new KnowledgeIntegrityError('Archive reference mismatch');
  return { archive, availableAt: String(row.available_at) };
}
export function eligibleArchive(
  db: DatabaseSync,
  mode: AsyncLlmMode,
  asOf: string,
): AvailableKnowledge | null {
  const row = db
    .prepare(
      'SELECT bundle_hash,available_at,seq FROM knowledge_archive_publications WHERE mode=? AND available_at<=? ORDER BY available_at DESC,seq DESC LIMIT 1',
    )
    .get(mode, asOf);
  if (!row) return null;
  const result = readArchive(db, String(row.bundle_hash));
  const availableAt = String(row.available_at);
  if (
    result.archive.advice.mode !== mode ||
    Date.parse(availableAt) > Date.parse(asOf) ||
    Date.parse(result.availableAt) > Date.parse(availableAt)
  )
    throw new KnowledgeIntegrityError('Archive eligibility mismatch');
  return { ...result, availableAt, publicationSeq: Number(row.seq) };
}
export function verifyPublication(
  db: DatabaseSync,
  hash: string,
  seq: number | undefined,
  at: string | undefined,
): void {
  const row =
    seq === undefined
      ? null
      : db
          .prepare(
            'SELECT bundle_hash,available_at FROM knowledge_archive_publications WHERE seq=?',
          )
          .get(seq);
  if (!row || row.bundle_hash !== hash || row.available_at !== at)
    throw new KnowledgeIntegrityError('Pinned archive publication is missing or changed');
}
