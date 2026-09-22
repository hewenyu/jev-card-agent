import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderAttempt, ProviderCall, ProviderMeter } from '../core/types.js';
import type { ResearchBatchV2 } from './contracts.js';
import type { AsyncResearchConfig } from './config.js';
export type ResearchJobState =
  'pending' | 'running' | 'completed' | 'failed' | 'superseded' | 'cancelled';
export interface ResearchJob {
  id: string;
  batch: ResearchBatchV2;
  state: ResearchJobState;
  generation: number;
  owner: string | null;
  leaseUntil: number | null;
  deadlineAt: number | null;
}
export interface ResearchQueueStatus {
  pending: number;
  runningJobs: number;
  completed: number;
  failed: number;
  superseded: number;
  cancelled: number;
  attempts: number;
  unknownUsage: number;
  costUsd: number | null;
  oldestPendingAt: string | null;
  latestCompletedAt: string | null;
}
/** Short transactions only. Model network waits never hold a database lock. */
export class ResearchQueue {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS research_jobs (
        id TEXT PRIMARY KEY, task_type TEXT NOT NULL, scope_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE, batch TEXT NOT NULL, state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER, deadline_at INTEGER,
        created_at TEXT NOT NULL, completed_at TEXT, error TEXT, outcome TEXT, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS research_jobs_state ON research_jobs(state,created_at);
      CREATE TABLE IF NOT EXISTS research_attempts (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, generation INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
        call TEXT NOT NULL, attempt TEXT, cost_usd REAL);
      CREATE INDEX IF NOT EXISTS research_attempts_job ON research_attempts(job_id,started_at);`);
  }
  shouldSchedule(batch: ResearchBatchV2, minimum: number): boolean {
    const row = this.db
      .prepare(
        'SELECT batch FROM research_jobs WHERE task_type=? AND scope_key=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(batch.taskType, batch.scopeKey);
    if (!row) return batch.eligibleHandIds.length >= minimum;
    const previous = JSON.parse(String(row.batch)) as ResearchBatchV2;
    if (batch.evidenceEventWatermark <= previous.evidenceEventWatermark) return false;
    const seen = new Set(previous.eligibleHandIds);
    return batch.eligibleHandIds.filter((id) => !seen.has(id)).length >= minimum;
  }
  enqueue(
    batch: ResearchBatchV2,
    model: string,
    maxPending = 8,
    now = new Date().toISOString(),
  ): string | null {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          batch.taskType,
          batch.scopeKey,
          batch.sourceSnapshotHash,
          batch.basePolicyVersion,
          model,
          batch.researchPromptVersion,
        ]),
      )
      .digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM research_jobs WHERE fingerprint=?').get(fingerprint)) {
        this.db.exec('COMMIT');
        return null;
      }
      const old = this.db
        .prepare(
          "SELECT id,batch FROM research_jobs WHERE state='pending' AND task_type=? AND scope_key=?",
        )
        .get(batch.taskType, batch.scopeKey);
      if (
        old &&
        (JSON.parse(String(old.batch)) as ResearchBatchV2).evidenceEventWatermark >=
          batch.evidenceEventWatermark
      ) {
        this.db.exec('COMMIT');
        return null;
      }
      const pending = Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE state='pending'").get()?.n ??
          0,
      );
      if (!old && pending >= maxPending) {
        this.db.exec('COMMIT');
        return null;
      }
      if (old)
        this.db
          .prepare(
            "UPDATE research_jobs SET state='superseded',completed_at=? WHERE id=? AND state='pending'",
          )
          .run(now, String(old.id));
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO research_jobs(id,task_type,scope_key,fingerprint,batch,state,created_at) VALUES(?,?,?,?,?,'pending',?)",
        )
        .run(id, batch.taskType, batch.scopeKey, fingerprint, JSON.stringify(batch), now);
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claim(owner: string, jobTimeoutMs: number, now = Date.now(), jobId?: string): ResearchJob | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // An expired lease isolates the old generation before recovery; an uncertain in-flight call stays billed unknown.
      this.db
        .prepare(
          "UPDATE research_jobs SET state='pending',owner=NULL,lease_until=NULL,deadline_at=NULL WHERE state='running' AND lease_until<=?",
        )
        .run(now);
      if (this.db.prepare("SELECT 1 FROM research_jobs WHERE state='running'").get()) {
        this.db.exec('COMMIT');
        return null;
      }
      const row = this.db
        .prepare(
          `SELECT * FROM research_jobs WHERE state='pending' ${jobId ? 'AND id=?' : ''} ORDER BY created_at,rowid LIMIT 1`,
        )
        .get(...(jobId ? [jobId] : []));
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const generation = Number(row.generation) + 1;
      this.db
        .prepare(
          "UPDATE research_jobs SET state='running',owner=?,generation=?,lease_until=?,deadline_at=? WHERE id=? AND state='pending'",
        )
        .run(owner, generation, now + 15000, now + jobTimeoutMs, String(row.id));
      this.db.exec('COMMIT');
      return {
        id: String(row.id),
        batch: JSON.parse(String(row.batch)) as ResearchBatchV2,
        state: 'running',
        generation,
        owner,
        leaseUntil: now + 15000,
        deadlineAt: now + jobTimeoutMs,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  owns(job: ResearchJob, now = Date.now()): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM research_jobs WHERE id=? AND state='running' AND owner=? AND generation=? AND lease_until>? AND deadline_at>?",
      )
      .get(job.id, job.owner, job.generation, now, now);
  }
  heartbeat(job: ResearchJob, now = Date.now()): boolean {
    const row = this.db
      .prepare(
        "UPDATE research_jobs SET lease_until=? WHERE id=? AND state='running' AND owner=? AND generation=? AND lease_until>? AND deadline_at>?",
      )
      .run(now + 15000, job.id, job.owner, job.generation, now, now);
    return Number(row.changes) === 1;
  }
  finish(
    job: ResearchJob,
    state: 'completed' | 'failed' | 'cancelled',
    outcome: unknown,
    error: string | null = null,
    now = Date.now(),
  ): boolean {
    // Completed replies additionally require the original deadline. Failures after deadline remain auditable.
    const result = this.db
      .prepare(
        `UPDATE research_jobs SET state=?,completed_at=?,outcome=?,error=?,lease_until=NULL WHERE id=? AND state='running' AND owner=? AND generation=? AND lease_until>? ${state === 'completed' ? 'AND deadline_at>?' : ''}`,
      )
      .run(
        state,
        new Date(now).toISOString(),
        JSON.stringify(outcome),
        error,
        job.id,
        job.owner,
        job.generation,
        now,
        ...(state === 'completed' ? [now] : []),
      );
    return Number(result.changes) === 1;
  }
  meter(job: ResearchJob, config: AsyncResearchConfig): ProviderMeter {
    return {
      before: (call: ProviderCall) => {
        if (!this.owns(job)) throw new Error('Research lease no longer owned');
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO research_attempts(id,job_id,generation,started_at,status,call) VALUES(?,?,?,?,'started',?)",
          )
          .run(id, job.id, job.generation, new Date().toISOString(), JSON.stringify(call));
        return id;
      },
      after: (attempt: ProviderAttempt, id: string) => {
        const usage = attempt.usage;
        let cost: number | null = null;
        if (
          usage &&
          attempt.actualModel === config.model &&
          config.inputPricePerMillion !== null &&
          config.outputPricePerMillion !== null &&
          (!(usage.cache_read_input_tokens ?? 0) || config.cacheReadPricePerMillion !== null) &&
          (!(usage.cache_creation_input_tokens ?? 0) || config.cacheCreationPricePerMillion != null)
        ) {
          const cache = usage.cache_read_input_tokens ?? 0;
          const creation = usage.cache_creation_input_tokens ?? 0;
          cost =
            ((usage.input_tokens - cache - creation) * config.inputPricePerMillion +
              cache * (config.cacheReadPricePerMillion ?? 0) +
              creation * (config.cacheCreationPricePerMillion ?? 0) +
              usage.output_tokens * config.outputPricePerMillion) /
            1e6;
        }
        this.db
          .prepare(
            'UPDATE research_attempts SET finished_at=?,status=?,attempt=?,cost_usd=? WHERE id=? AND job_id=? AND generation=?',
          )
          .run(
            new Date().toISOString(),
            attempt.status,
            JSON.stringify(attempt),
            cost,
            id,
            job.id,
            job.generation,
          );
      },
    };
  }
  completedUndelivered(): Array<{ job: ResearchJob; outcome: unknown }> {
    return this.db
      .prepare(
        "SELECT * FROM research_jobs WHERE state='completed' AND delivered=0 ORDER BY completed_at LIMIT 16",
      )
      .all()
      .map((row) => ({
        job: {
          id: String(row.id),
          batch: JSON.parse(String(row.batch)) as ResearchBatchV2,
          state: 'completed',
          generation: Number(row.generation),
          owner: row.owner as string | null,
          leaseUntil: null,
          deadlineAt: null,
        },
        outcome: JSON.parse(String(row.outcome)) as unknown,
      }));
  }
  delivered(id: string): void {
    this.db
      .prepare("UPDATE research_jobs SET delivered=1 WHERE id=? AND state='completed'")
      .run(id);
  }
  status(): ResearchQueueStatus {
    const counts = Object.fromEntries(
      this.db
        .prepare('SELECT state,COUNT(*) AS n FROM research_jobs GROUP BY state')
        .all()
        .map((r) => [String(r.state), Number(r.n)]),
    );
    const usage = this.db
      .prepare(
        "SELECT COUNT(*) AS n,SUM(CASE WHEN attempt IS NULL OR json_extract(attempt,'$.usage') IS NULL THEN 1 ELSE 0 END) AS unknown,SUM(cost_usd) AS cost,COUNT(cost_usd) AS priced FROM research_attempts",
      )
      .get()!;
    return {
      pending: counts.pending ?? 0,
      runningJobs: counts.running ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      superseded: counts.superseded ?? 0,
      cancelled: counts.cancelled ?? 0,
      attempts: Number(usage.n),
      unknownUsage: Number(usage.unknown ?? 0),
      costUsd:
        Number(usage.priced) === Number(usage.n) && Number(usage.n) > 0 ? Number(usage.cost) : null,
      oldestPendingAt: this.db
        .prepare("SELECT MIN(created_at) AS t FROM research_jobs WHERE state='pending'")
        .get()?.t as string | null,
      latestCompletedAt: this.db
        .prepare("SELECT MAX(completed_at) AS t FROM research_jobs WHERE state='completed'")
        .get()?.t as string | null,
    };
  }
  close(): void {
    this.db.close();
  }
}
