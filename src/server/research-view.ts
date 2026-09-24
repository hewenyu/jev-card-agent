import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AdviceStore } from '../knowledge/advice-store.js';
import type { AsyncResearchStatus } from '../research/engine.js';
import type { ResearchPublicView, ResearchSummary } from '../shared/research.js';
import { connectionRevision } from '../storage/connection-revision.js';
import { opponentKey } from '../knowledge/advice-validator.js';
import {
  emptyDecisionCounts,
  researchActivity,
  ResearchActivityCounter,
  type DecisionCounts,
} from './research-activity.js';

/** Bounded approved summaries are public; raw responses, evidence and operator notes stay private. */
export class ResearchMonitor {
  private reader: AdviceStore | null = null;
  private cursor = 0;
  private evaluated = 0;
  private adopted = 0;
  private unmatched = 0;
  private readonly byRun = new Map<string, DecisionCounts>();
  private readonly activityCounter = new ResearchActivityCounter();
  private view: ResearchPublicView;
  private projectionRevision?: string;
  private projectionExpiresAt = 0;
  private namesCursor = -1;
  private names = new Map<string, string>();
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
        'SELECT rowid AS cursor,run_id,context,proposal FROM decisions WHERE rowid>? ORDER BY rowid LIMIT 32',
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
        const run = this.byRun.get(String(row.run_id)) ?? emptyDecisionCounts();
        this.byRun.set(String(row.run_id), run);
        this.evaluated++;
        run.evaluated++;
        if (proposal.request?.state?.approvedAdvice?.length) {
          this.adopted++;
          run.adopted++;
        }
        if (!context.advice.items?.length) {
          this.unmatched++;
          run.unmatched++;
        }
      }
      this.cursor = Number(row.cursor);
    }
    Object.assign(summary, {
      adoptedDecisions: this.adopted,
      evaluatedDecisions: this.evaluated,
      unmatchedDecisions: this.unmatched,
    });
    const hasLedger =
      this.reader?.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('research_attempts','research_jobs')",
        )
        .get()?.n === 2;
    summary.activity = researchActivity(
      this.raw,
      hasLedger ? this.reader!.db : null,
      { evaluated: this.evaluated, adopted: this.adopted, unmatched: this.unmatched },
      this.byRun,
      !this.raw.prepare('SELECT 1 FROM decisions WHERE rowid>? LIMIT 1').get(this.cursor),
      this.activityCounter,
    );
    const namesCursor = Number(
      this.raw.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM decisions').get()!.n,
    );
    if (namesCursor !== this.namesCursor) {
      const latest = this.raw
        .prepare('SELECT context FROM decisions WHERE rowid=?')
        .get(namesCursor);
      const seats = latest
        ? (JSON.parse(String(latest.context)) as { seats?: Array<{ name?: string; seat: number }> })
            .seats
        : [];
      this.names = new Map(
        (seats ?? [])
          .filter((seat) => typeof seat.name === 'string' && seat.name.length > 0)
          .map((seat) => [opponentKey(seat.name!), seat.name!.slice(0, 80)]),
      );
      this.namesCursor = namesCursor;
    }
    summary.schedules = (status.schedules ?? []).map((schedule) => ({
      ...schedule,
      label:
        schedule.taskType === 'leak_review'
          ? 'Global decision review'
          : (this.names.get(schedule.scopeKey) ?? `Opponent ${schedule.scopeKey.slice(-8)}`),
    }));
    let proposals: ResearchPublicView['proposals'] = [],
      publications: ResearchPublicView['publications'] = [];
    const now = Date.now();
    const revision = this.reader ? connectionRevision(this.reader.db) : undefined;
    if (this.reader && (revision !== this.projectionRevision || now >= this.projectionExpiresAt)) {
      const store = this.reader;
      const counts = Object.fromEntries(
        store.db
          .prepare('SELECT status,COUNT(*) AS n FROM advice_proposals GROUP BY status')
          .all()
          .map((row) => [String(row.status), Number(row.n)]),
      );
      summary.awaitingReview = counts.pending ?? 0;
      summary.approved = counts.approved ?? 0;
      const states = store.db
        .prepare(
          `SELECT p.id,p.seq,json_extract(p.payload,'$.expiresAt') AS expires_at,CASE
        WHEN EXISTS(SELECT 1 FROM advice_audit a WHERE a.subject_id=p.id AND a.action='withdrawn') THEN 'withdrawn'
        WHEN EXISTS(SELECT 1 FROM advice_publications n WHERE n.topic_key=p.topic_key AND n.revision>p.revision) THEN 'superseded'
        WHEN json_extract(p.payload,'$.expiresAt')<=? THEN 'expired' ELSE 'published' END AS status
        FROM advice_publications p ORDER BY seq DESC`,
        )
        .all(new Date(now).toISOString());
      this.projectionExpiresAt = states.reduce((next, row) => {
        const expires = Date.parse(String(row.expires_at));
        return expires > now ? Math.min(next, expires) : next;
      }, Infinity);
      const statuses = new Map(
        states.map((row) => [
          String(row.id),
          String(row.status) as ResearchPublicView['publications'][number]['status'],
        ]),
      );
      summary.published = states.filter((r) => r.status === 'published').length;
      summary.expired = states.filter((r) => r.status === 'expired').length;
      summary.withdrawn = states.filter((r) => r.status === 'withdrawn').length;
      const pricing = hasLedger
        ? store.db
            .prepare(
              'SELECT SUM(cost_usd) AS known,COUNT(*) AS n,COUNT(cost_usd) AS priced FROM research_attempts',
            )
            .get()
        : null;
      summary.knownCostUsd = !hasLedger
        ? null
        : pricing?.known == null
          ? Number(pricing?.n ?? 0) > 0
            ? null
            : 0
          : Number(pricing.known);
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
        observation: p.hypothesis,
        limitations: p.limitations,
        ...(p.recipeId ? { recipeId: p.recipeId } : {}),
        approvalSource: p.approvalSource,
      }));
      this.projectionRevision = revision;
    } else if (this.reader) {
      for (const key of [
        'awaitingReview',
        'approved',
        'published',
        'expired',
        'withdrawn',
        'knownCostUsd',
        'unpricedCalls',
      ] as const) {
        Object.assign(summary, { [key]: this.view.status[key] });
      }
      proposals = this.view.proposals;
      publications = this.view.publications;
    }
    summary.latestPublicationAt = publications[0]?.publishedAt ?? null;
    summary.latestAdviceAgeMs = summary.latestPublicationAt
      ? Math.max(0, now - Date.parse(summary.latestPublicationAt))
      : null;
    this.view = { status: summary, proposals, publications };
  }
  current(): ResearchPublicView {
    return structuredClone(this.view);
  }
  status(): ResearchSummary {
    return structuredClone(this.view.status);
  }
  fail(): void {
    this.view.status.error = 'Research status unavailable';
  }
  close(): void {
    this.reader?.close();
    this.reader = null;
  }
}
