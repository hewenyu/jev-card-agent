import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ResearchBatchV2, ResearchModelMetadata } from '../research/contracts.js';
import { ADVICE_LIMITS } from './advice-selector.js';
import {
  GUIDANCE_RECIPE_ID,
  GUIDANCE_SMALL_SAMPLE_HANDS,
  GUIDANCE_SMALL_SAMPLE_TTL_MS,
} from './advice-guidance.js';
export { GUIDANCE_RECIPE_ID } from './advice-guidance.js';
import type {
  AdviceAudit,
  AdviceBundle,
  AdviceReview,
  AsyncLlmMode,
  ProposalRecord,
  PublishedAdvice,
} from './advice-types.js';
import {
  AdviceValidator,
  contentHash,
  hashAdviceBundle,
  hashPublication,
  REQUIRED_REVIEW_SCENARIOS,
  validateAdviceBundle,
} from './advice-validator.js';

export const APPROVED_RECIPE_ID = 'opponent-evidence-v2';
export const RECIPE_GUIDANCE = 'Use within scope; infer neither hidden cards nor bluff rates.';
export const RECIPE_LIMITATION = 'Limited, selected samples.';
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_MS = 7 * MAX_TTL_MS;
interface PublishOptions {
  expectedRevision: number;
  ttlMs: number;
  priority?: number;
  actor: string;
}
interface OperatorNote {
  actor: string;
  note: string;
}

/** A separate derived database; no access to runtime controls or arena credentials. */
export class AdviceStore {
  readonly db: DatabaseSync;
  private readonly clock: () => Date;
  constructor(path: string, options: { readOnly?: boolean; clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
    if (!options.readOnly && path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (!options.readOnly && path !== ':memory:') chmodSync(path, 0o600);
    if (options.readOnly) {
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
      return;
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS advice_proposals (
        id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE, received_ms INTEGER NOT NULL,
        status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS advice_publications (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, proposal_id TEXT NOT NULL UNIQUE,
        topic_key TEXT NOT NULL, revision INTEGER NOT NULL, available_ms INTEGER NOT NULL,
        payload TEXT NOT NULL, UNIQUE(topic_key,revision));
      CREATE TABLE IF NOT EXISTS advice_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, action TEXT NOT NULL,
        subject_id TEXT NOT NULL, actor TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS advice_recipes (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, approved_ms INTEGER NOT NULL, note TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS advice_metric_snapshots (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, watermark INTEGER NOT NULL,
        available_ms INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS advice_audit_subject ON advice_audit(subject_id,action,at_ms);
      CREATE TRIGGER IF NOT EXISTS advice_publications_no_update BEFORE UPDATE ON advice_publications
        BEGIN SELECT RAISE(ABORT,'immutable advice publication'); END;
      CREATE TRIGGER IF NOT EXISTS advice_publications_no_delete BEFORE DELETE ON advice_publications
        BEGIN SELECT RAISE(ABORT,'immutable advice publication'); END;
      CREATE TRIGGER IF NOT EXISTS advice_audit_no_update BEFORE UPDATE ON advice_audit
        BEGIN SELECT RAISE(ABORT,'immutable advice audit'); END;
      CREATE TRIGGER IF NOT EXISTS advice_audit_no_delete BEFORE DELETE ON advice_audit
        BEGIN SELECT RAISE(ABORT,'immutable advice audit'); END;
      CREATE TRIGGER IF NOT EXISTS advice_metric_snapshots_no_update BEFORE UPDATE ON advice_metric_snapshots
        BEGIN SELECT RAISE(ABORT,'immutable support snapshot'); END;
      CREATE TRIGGER IF NOT EXISTS advice_metric_snapshots_no_delete BEFORE DELETE ON advice_metric_snapshots
        BEGIN SELECT RAISE(ABORT,'immutable support snapshot'); END;`);
  }
  private now(): string {
    return this.clock().toISOString();
  }
  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private note(note: OperatorNote): void {
    if (
      !note.actor.trim() ||
      note.actor.length > 160 ||
      !note.note.trim() ||
      note.note.length > 2000
    )
      throw new Error('Explicit operator identity and review note required');
  }
  private audit(
    action: string,
    subjectId: string,
    actor: string,
    details: Record<string, unknown>,
    at = this.now(),
  ): void {
    this.db
      .prepare('INSERT INTO advice_audit(at_ms,action,subject_id,actor,details) VALUES(?,?,?,?,?)')
      .run(Date.parse(at), action, subjectId, actor, JSON.stringify(details));
  }
  ingest(batch: ResearchBatchV2, raw: unknown, model: ResearchModelMetadata): ProposalRecord {
    const receivedAt = this.now();
    let proposal;
    try {
      proposal = new AdviceValidator().validate(raw, batch, receivedAt);
    } catch (error) {
      this.audit('validation_rejected', batch.batchId, 'validator', {
        error: error instanceof Error ? error.message : String(error),
        inputHash: contentHash(raw),
        batchHash: batch.sourceSnapshotHash,
      });
      throw error;
    }
    const hash = contentHash({ batchHash: batch.sourceSnapshotHash, proposal, model });
    const existing = this.db
      .prepare('SELECT id FROM advice_proposals WHERE content_hash=?')
      .get(hash);
    if (existing) return this.getProposal(String(existing.id))!;
    const record: ProposalRecord = {
      proposalId: randomUUID(),
      contentHash: hash,
      receivedAt,
      model: structuredClone(model),
      batch: structuredClone(batch),
      proposal,
      status: 'pending',
    };
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO advice_proposals(id,content_hash,received_ms,status,payload) VALUES(?,?,?,?,?)',
        )
        .run(record.proposalId, hash, Date.parse(receivedAt), 'pending', JSON.stringify(record));
      this.audit(
        'validated',
        record.proposalId,
        'validator',
        { batchId: batch.batchId, hash },
        receivedAt,
      );
    });
    return record;
  }
  /** Refresh code-produced support facts without invoking or waiting for the model. */
  refreshEvidence(raw: ResearchBatchV2): void {
    const batch = new AdviceValidator().validateBatch(raw);
    const receivedAt = this.now();
    if (Date.parse(batch.cutoff) > Date.parse(receivedAt))
      throw new Error('Future support evidence');
    const id = contentHash({
      scopeKey: batch.scopeKey,
      watermark: batch.evidenceEventWatermark,
      metrics: batch.metrics,
    });
    const payload = {
      batchId: batch.batchId,
      batchHash: batch.sourceSnapshotHash,
      cutoff: batch.cutoff,
      metrics: batch.metrics,
      receivedAt,
    };
    this.db
      .prepare(
        'INSERT OR IGNORE INTO advice_metric_snapshots(id,scope_key,watermark,available_ms,payload) VALUES(?,?,?,?,?)',
      )
      .run(
        id,
        batch.scopeKey,
        batch.evidenceEventWatermark,
        Date.parse(receivedAt),
        JSON.stringify(payload),
      );
  }
  getProposal(id: string): ProposalRecord | null {
    const row = this.db.prepare('SELECT payload,status FROM advice_proposals WHERE id=?').get(id);
    if (!row) return null;
    const record = JSON.parse(String(row.payload)) as ProposalRecord;
    record.status = String(row.status) as ProposalRecord['status'];
    if (
      record.contentHash !==
      contentHash({
        batchHash: record.batch.sourceSnapshotHash,
        proposal: record.proposal,
        model: record.model,
      })
    )
      throw new Error('Proposal integrity failure');
    return record;
  }
  listProposals(limit = 100): ProposalRecord[] {
    return this.db
      .prepare('SELECT id FROM advice_proposals ORDER BY received_ms DESC,id LIMIT ?')
      .all(Math.min(1000, Math.max(1, limit)))
      .map((row) => this.getProposal(String(row.id))!);
  }
  private requireProposal(id: string): ProposalRecord {
    const record = this.getProposal(id);
    if (!record) throw new Error('Unknown proposal');
    return record;
  }
  approve(id: string, review: AdviceReview): ProposalRecord {
    this.note(review);
    return this.transaction(() => {
      const record = this.requireProposal(id);
      if (record.status !== 'pending') throw new Error('Only pending proposals can be approved');
      const required = [...REQUIRED_REVIEW_SCENARIOS, ...record.proposal.requiredScenarios];
      if (required.some((item) => !review.passedScenarios.includes(item)))
        throw new Error('Independent scenario and evidence review incomplete');
      new AdviceValidator().validate(record.proposal, record.batch, this.now());
      this.db.prepare("UPDATE advice_proposals SET status='approved' WHERE id=?").run(id);
      this.audit('approved', id, review.actor, {
        note: review.note,
        passedScenarios: review.passedScenarios,
        source: 'manual',
      });
      return this.requireProposal(id);
    });
  }
  reject(id: string, note: OperatorNote): ProposalRecord {
    this.note(note);
    return this.transaction(() => {
      const record = this.requireProposal(id);
      if (!['pending', 'approved'].includes(record.status))
        throw new Error('Only unpublished proposals can be rejected');
      this.db.prepare("UPDATE advice_proposals SET status='rejected' WHERE id=?").run(id);
      this.audit('rejected', id, note.actor, { note: note.note });
      return this.requireProposal(id);
    });
  }
  approveRecipe(note: OperatorNote): void {
    this.note(note);
    this.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO advice_recipes(id,actor,approved_ms,note) VALUES(?,?,?,?)')
        .run(APPROVED_RECIPE_ID, note.actor, Date.parse(this.now()), note.note);
      this.audit('recipe_approved', APPROVED_RECIPE_ID, note.actor, {
        note: note.note,
        guidance: RECIPE_GUIDANCE,
        limitation: RECIPE_LIMITATION,
      });
    });
  }
  approveGuidance(note: OperatorNote): void {
    this.note(note);
    this.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO advice_recipes(id,actor,approved_ms,note) VALUES(?,?,?,?)')
        .run(GUIDANCE_RECIPE_ID, note.actor, Date.parse(this.now()), note.note);
      this.audit('recipe_approved', GUIDANCE_RECIPE_ID, note.actor, {
        note: note.note,
        contract:
          'Evidence-bound conditional model guidance; validation does not prove profitability.',
        smallSampleTtlMs: GUIDANCE_SMALL_SAMPLE_TTL_MS,
      });
    });
  }
  publishApprovedRecipe(id: string, options: PublishOptions): PublishedAdvice {
    return this.transaction(() => {
      const record = this.requireProposal(id);
      const recipeId = record.proposal.proposedRecipeId;
      if (
        record.status !== 'pending' ||
        record.proposal.kind !== 'opponent_brief' ||
        !recipeId ||
        ![APPROVED_RECIPE_ID, GUIDANCE_RECIPE_ID].includes(recipeId)
      )
        throw new Error('Only eligible pending opponent recipes may auto-publish');
      if (!this.db.prepare('SELECT id FROM advice_recipes WHERE id=?').get(recipeId))
        throw new Error('Recipe requires prior operator approval');
      return this.publishRecord(record, options, 'approved_recipe');
    });
  }
  publish(id: string, options: PublishOptions): PublishedAdvice {
    return this.transaction(() => {
      const record = this.requireProposal(id);
      if (record.status !== 'approved')
        throw new Error('Publication requires independent approval');
      return this.publishRecord(record, options, 'manual');
    });
  }
  private publishRecord(
    record: ProposalRecord,
    options: PublishOptions,
    source: PublishedAdvice['approvalSource'],
  ): PublishedAdvice {
    const now = this.now();
    if (
      !options.actor.trim() ||
      !Number.isInteger(options.expectedRevision) ||
      options.expectedRevision < 0 ||
      !Number.isFinite(options.ttlMs) ||
      options.ttlMs <= 0 ||
      options.ttlMs > MAX_TTL_MS ||
      !Number.isInteger(options.priority ?? 0) ||
      Math.abs(options.priority ?? 0) > 100
    )
      throw new Error('Invalid publication policy');
    new AdviceValidator().validate(record.proposal, record.batch, now);
    if (Date.parse(now) - Date.parse(record.batch.cutoff) >= MAX_EVIDENCE_AGE_MS)
      throw new Error('Evidence exceeds publication freshness policy');
    const topicKey = contentHash({ kind: record.proposal.kind, scope: record.proposal.scope });
    const previous = this.db
      .prepare(
        'SELECT revision,payload FROM advice_publications WHERE topic_key=? ORDER BY revision DESC LIMIT 1',
      )
      .get(topicKey);
    const revision = Number(previous?.revision ?? 0);
    if (revision !== options.expectedRevision) throw new Error('Advice revision CAS conflict');
    if (previous) {
      const previousAdvice = JSON.parse(String(previous.payload)) as PublishedAdvice;
      if (
        record.batch.evidenceEventWatermark < previousAdvice.evidenceWatermark ||
        Date.parse(record.batch.cutoff) < Date.parse(previousAdvice.evidenceCutoff)
      )
        throw new Error('Older same-topic evidence cannot replace current advice');
    }
    const seq = Number(
      this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM advice_publications').get()!.next,
    );
    const proposal = record.proposal;
    const fixedTemplate =
      source === 'approved_recipe' && proposal.proposedRecipeId === APPROVED_RECIPE_ID;
    const scopedGuidance =
      source === 'approved_recipe' && proposal.proposedRecipeId === GUIDANCE_RECIPE_ID;
    const ttlMs =
      scopedGuidance && record.batch.eligibleHandIds.length < GUIDANCE_SMALL_SAMPLE_HANDS
        ? Math.min(options.ttlMs, GUIDANCE_SMALL_SAMPLE_TTL_MS)
        : options.ttlMs;
    const content: Omit<PublishedAdvice, 'contentHash'> = {
      publicationId: randomUUID(),
      publicationSeq: seq,
      proposalId: record.proposalId,
      topicKey,
      adviceRevision: revision + 1,
      evidenceWatermark: record.batch.evidenceEventWatermark,
      evidenceCutoff: record.batch.cutoff,
      receivedAt: record.receivedAt,
      publishedAt: now,
      availableAt: now,
      expiresAt: new Date(
        Math.min(Date.parse(now) + ttlMs, Date.parse(record.batch.cutoff) + MAX_EVIDENCE_AGE_MS),
      ).toISOString(),
      basePolicyVersion: proposal.basePolicyVersion,
      scope: structuredClone(proposal.scope),
      priority: options.priority ?? 0,
      hypothesis: fixedTemplate ? 'Conditional action frequencies only.' : proposal.hypothesis,
      guidance: fixedTemplate ? RECIPE_GUIDANCE : proposal.suggestedGuidance,
      limitations: fixedTemplate ? [RECIPE_LIMITATION] : proposal.limitations,
      metrics: record.batch.metrics.filter((metric) => proposal.metricRefs.includes(metric.id)),
      invalidateWhen: proposal.invalidateWhen,
      approvalSource: source,
      ...(scopedGuidance ? { recipeId: GUIDANCE_RECIPE_ID } : {}),
    };
    if (source === 'approved_recipe') {
      // Match the selector's Unicode character accounting before making an immutable publication.
      // Preserve all verified metrics; an oversized proposal remains pending for independent review.
      const characters = [
        ...[
          content.hypothesis,
          content.guidance,
          ...content.limitations,
          ...content.metrics.map(
            (metric) => `${metric.name}: ${metric.numerator}/${metric.denominator}`,
          ),
        ].join(''),
      ].length;
      if (characters > ADVICE_LIMITS.itemCharacters)
        throw new Error('Approved recipe exceeds live advice character limit');
    }
    const publication = { ...content, contentHash: hashPublication(content) };
    this.db
      .prepare(
        'INSERT INTO advice_publications(seq,id,proposal_id,topic_key,revision,available_ms,payload) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        seq,
        publication.publicationId,
        record.proposalId,
        topicKey,
        revision + 1,
        Date.parse(now),
        JSON.stringify(publication),
      );
    this.db
      .prepare("UPDATE advice_proposals SET status='published' WHERE id=?")
      .run(record.proposalId);
    this.audit(
      'published',
      publication.publicationId,
      options.actor,
      {
        proposalId: record.proposalId,
        revision: revision + 1,
        source,
        contentHash: publication.contentHash,
      },
      now,
    );
    return publication;
  }
  withdraw(id: string, note: OperatorNote): void {
    this.note(note);
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM advice_publications WHERE id=?').get(id))
        throw new Error('Unknown publication');
      if (
        this.db
          .prepare("SELECT seq FROM advice_audit WHERE subject_id=? AND action='withdrawn'")
          .get(id)
      )
        return;
      this.audit('withdrawn', id, note.actor, { note: note.note });
    });
  }
  listPublications(limit = 100): PublishedAdvice[] {
    return this.db
      .prepare('SELECT payload FROM advice_publications ORDER BY seq DESC LIMIT ?')
      .all(Math.min(1000, Math.max(1, limit)))
      .map((row) => {
        const item = JSON.parse(String(row.payload)) as PublishedAdvice;
        if (item.contentHash !== hashPublication(item))
          throw new Error('Publication integrity failure');
        return item;
      });
  }
  listAudit(limit = 100): AdviceAudit[] {
    return this.db
      .prepare('SELECT * FROM advice_audit ORDER BY seq DESC LIMIT ?')
      .all(Math.min(1000, Math.max(1, limit)))
      .map((row) => ({
        auditId: Number(row.seq),
        at: new Date(Number(row.at_ms)).toISOString(),
        action: String(row.action),
        subjectId: String(row.subject_id),
        actor: String(row.actor),
        details: JSON.parse(String(row.details)) as Record<string, unknown>,
      }));
  }
  bundle(options: {
    mode: AsyncLlmMode;
    basePolicyVersion: string;
    admissibleAt: string;
    maxItems?: number;
  }): AdviceBundle {
    const at = Date.parse(options.admissibleAt);
    if (!Number.isFinite(at) || at > Date.parse(this.now()))
      throw new Error('Invalid advice admission boundary');
    const rows =
      options.mode === 'live'
        ? this.db
            .prepare(
              `SELECT p.payload FROM advice_publications p
      WHERE p.available_ms<=? AND NOT EXISTS (SELECT 1 FROM advice_publications newer
        WHERE newer.topic_key=p.topic_key AND newer.revision>p.revision AND newer.available_ms<=?)
      AND NOT EXISTS (SELECT 1 FROM advice_audit a WHERE a.subject_id=p.id AND a.action='withdrawn' AND a.at_ms<=?)
      ORDER BY p.seq DESC LIMIT 256`,
            )
            .all(at, at, at)
        : [];
    const publications = rows
      .map((row) => JSON.parse(String(row.payload)) as PublishedAdvice)
      .filter(
        (item) =>
          item.basePolicyVersion === options.basePolicyVersion && Date.parse(item.expiresAt) > at,
      );
    const supportRows =
      options.mode === 'live'
        ? this.db
            .prepare(
              `SELECT s.* FROM advice_metric_snapshots s
      WHERE s.available_ms<=? AND NOT EXISTS (SELECT 1 FROM advice_metric_snapshots newer
        WHERE newer.scope_key=s.scope_key AND newer.available_ms<=? AND
        (newer.watermark>s.watermark OR (newer.watermark=s.watermark AND newer.rowid>s.rowid)))
      ORDER BY s.watermark DESC LIMIT 64`,
            )
            .all(at, at)
        : [];
    const relevantMetricIds = new Set(
      publications.flatMap((item) => item.metrics.map((metric) => metric.id)),
    );
    const supportMetrics = supportRows
      .flatMap((row) => {
        const payload = JSON.parse(String(row.payload)) as {
          metrics: ResearchBatchV2['metrics'];
          receivedAt: string;
          cutoff: string;
        };
        if (
          String(row.id) !==
            contentHash({
              scopeKey: String(row.scope_key),
              watermark: Number(row.watermark),
              metrics: payload.metrics,
            }) ||
          Date.parse(payload.receivedAt) !== Number(row.available_ms) ||
          !Number.isFinite(Date.parse(payload.cutoff)) ||
          Date.parse(payload.cutoff) > Number(row.available_ms) ||
          payload.metrics.some(
            (metric) =>
              metric.throughEventId > Number(row.watermark) ||
              Date.parse(metric.availableAt) > Date.parse(payload.cutoff),
          )
        )
          throw new Error('Support snapshot integrity failure');
        return payload.metrics.filter((metric) => relevantMetricIds.has(metric.id));
      })
      .slice(0, 1024);
    const content: Omit<AdviceBundle, 'bundleHash'> = {
      schemaVersion: 'advice-bundle-v1',
      mode: options.mode,
      basePolicyVersion: options.basePolicyVersion,
      selectorVersion: 'scope-selector-v1',
      availableAt: new Date(
        Math.max(
          0,
          ...publications.map((item) => Date.parse(item.availableAt)),
          ...supportRows.map((row) => Number(row.available_ms)),
        ),
      ).toISOString(),
      publications,
      ...(supportMetrics.length ? { supportMetrics } : {}),
      ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
    };
    const bundle = { ...content, bundleHash: hashAdviceBundle(content) };
    validateAdviceBundle(bundle);
    return bundle;
  }
  close(): void {
    this.db.close();
  }
}
