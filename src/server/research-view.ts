import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AdviceStore } from '../knowledge/advice-store.js';
import type { AsyncResearchStatus } from '../research/engine.js';
import type { ResearchPublicView, ResearchSummary } from '../shared/research.js';

/** Bounded public projection; full model text, evidence and operator notes stay private. */
export class ResearchMonitor {
  private reader: AdviceStore | null = null;
  private cursor = 0;
  private evaluated = 0;
  private adopted = 0;
  private unmatched = 0;
  private view: ResearchPublicView;
  constructor(
    private readonly path: string,
    private readonly raw: DatabaseSync,
    initial: AsyncResearchStatus,
  ) {
    this.view = { status: this.summary(initial), proposals: [], publications: [] };
  }
  private summary(status: AsyncResearchStatus): ResearchSummary {
    return {
      mode: status.mode,
      configuredMode: status.configuredMode,
      running: status.running,
      error: status.error ? 'Research unavailable' : null,
      pending: status.pending,
      executing: status.runningJobs,
      failed: status.failed,
      awaitingReview: 0,
      approved: 0,
      published: 0,
      expired: 0,
      withdrawn: 0,
      lastCompletedAt: status.latestCompletedAt,
      latestPublicationAt: null,
      knownCostUsd: status.costUsd,
      unpricedCalls: status.costUsd === null ? status.attempts : 0,
      unknownUsageCalls: status.unknownUsage,
      attempts: status.attempts,
      adoptedDecisions: this.adopted,
      evaluatedDecisions: this.evaluated,
      unmatchedDecisions: this.unmatched,
      latestAdviceAgeMs: null,
    };
  }
  refresh(status: AsyncResearchStatus): void {
    const summary = this.summary(status);
    if (!this.reader && this.path !== ':memory:' && existsSync(this.path))
      this.reader = new AdviceStore(this.path, { readOnly: true });
    // Incremental scan, never inside a live action or spectator event. All source decisions remain intact.
    const rows = this.raw
      .prepare(
        'SELECT rowid AS cursor,context,proposal FROM decisions WHERE rowid>? ORDER BY rowid LIMIT 500',
      )
      .all(this.cursor);
    for (const row of rows) {
      const context = JSON.parse(String(row.context)) as {
        advice?: { mode?: string; items?: unknown[] };
      };
      const proposal = JSON.parse(String(row.proposal)) as {
        request?: { state?: { approvedAdvice?: unknown[] } };
      };
      if (context.advice?.mode === 'live') {
        this.evaluated++;
        if (proposal.request?.state?.approvedAdvice?.length) this.adopted++;
        if (!context.advice.items?.length) this.unmatched++;
      }
      this.cursor = Number(row.cursor);
    }
    Object.assign(summary, {
      adoptedDecisions: this.adopted,
      evaluatedDecisions: this.evaluated,
      unmatchedDecisions: this.unmatched,
    });
    let proposals: ResearchPublicView['proposals'] = [],
      publications: ResearchPublicView['publications'] = [];
    if (this.reader) {
      const store = this.reader;
      const counts = Object.fromEntries(
        store.db
          .prepare('SELECT status,COUNT(*) AS n FROM advice_proposals GROUP BY status')
          .all()
          .map((row) => [String(row.status), Number(row.n)]),
      );
      summary.awaitingReview = counts.pending ?? 0;
      summary.approved = counts.approved ?? 0;
      const now = Date.now();
      const states = store.db
        .prepare(
          `SELECT p.id,p.seq,CASE
        WHEN EXISTS(SELECT 1 FROM advice_audit a WHERE a.subject_id=p.id AND a.action='withdrawn') THEN 'withdrawn'
        WHEN EXISTS(SELECT 1 FROM advice_publications n WHERE n.topic_key=p.topic_key AND n.revision>p.revision) THEN 'superseded'
        WHEN json_extract(p.payload,'$.expiresAt')<=? THEN 'expired' ELSE 'published' END AS status
        FROM advice_publications p ORDER BY seq DESC`,
        )
        .all(new Date(now).toISOString());
      const statuses = new Map(
        states.map((row) => [
          String(row.id),
          String(row.status) as ResearchPublicView['publications'][number]['status'],
        ]),
      );
      summary.published = states.filter((r) => r.status === 'published').length;
      summary.expired = states.filter((r) => r.status === 'expired').length;
      summary.withdrawn = states.filter((r) => r.status === 'withdrawn').length;
      const pricing = store.db
        .prepare(
          'SELECT SUM(cost_usd) AS known,COUNT(*) AS n,COUNT(cost_usd) AS priced FROM research_attempts',
        )
        .get();
      summary.knownCostUsd =
        pricing?.known == null ? (Number(pricing?.n ?? 0) > 0 ? null : 0) : Number(pricing.known);
      summary.unpricedCalls = Number(pricing?.n ?? 0) - Number(pricing?.priced ?? 0);
      proposals = store.listProposals(20).map((p) => ({
        id: p.proposalId,
        kind: p.proposal.kind,
        status: p.status,
        receivedAt: p.receivedAt,
        model: p.model.actualModel,
        evidenceHands: p.batch.eligibleHandIds.length,
      }));
      publications = store.listPublications(20).map((p) => ({
        id: p.publicationId,
        proposalId: p.proposalId,
        revision: p.adviceRevision,
        sequence: p.publicationSeq,
        status: statuses.get(p.publicationId) ?? 'published',
        publishedAt: p.publishedAt,
        expiresAt: p.expiresAt,
        evidenceCutoff: p.evidenceCutoff,
        guidance: p.guidance,
        approvalSource: p.approvalSource,
      }));
      summary.latestPublicationAt = publications[0]?.publishedAt ?? null;
      summary.latestAdviceAgeMs = summary.latestPublicationAt
        ? Math.max(0, now - Date.parse(summary.latestPublicationAt))
        : null;
    }
    this.view = { status: summary, proposals, publications };
  }
  current(): ResearchPublicView {
    return structuredClone(this.view);
  }
  fail(): void {
    this.view.status.error = 'Research status unavailable';
  }
  close(): void {
    this.reader?.close();
    this.reader = null;
  }
}
