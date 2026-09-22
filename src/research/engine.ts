import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdviceStore } from '../knowledge/advice-store.js';
import { contentHash } from '../knowledge/advice-validator.js';
import { EvidenceBuilder } from './evidence.js';
import { ResearchQueue, type ResearchQueueStatus } from './queue.js';
import {
  LlmResearchProvider,
  type BatchResearchProvider,
  type ResearchResponse,
} from './llm-provider.js';
import { AsyncControlStore, effectiveResearchMode } from './control.js';
import type { AsyncResearchConfig } from './config.js';
import type { ProviderMeter } from '../core/types.js';
export interface AsyncResearchStatus extends ResearchQueueStatus {
  configuredMode: AsyncResearchConfig['mode'];
  mode: AsyncResearchConfig['mode'];
  running: boolean;
  liveConfirmed: boolean;
  lastTickAt: string | null;
  error: string | null;
}
export type ResearchProviderFactory = (meter: ProviderMeter) => BatchResearchProvider;
/** Single isolated background owner; no arena runtime, action sender, or raw writes. */
export class ResearchEngine {
  readonly queue: ResearchQueue;
  readonly advice: AdviceStore;
  private readonly controls: AsyncControlStore;
  private readonly evidence: EvidenceBuilder;
  private readonly owner = randomUUID();
  private active = false;
  private lastTickAt: string | null = null;
  private error: string | null = null;
  constructor(
    rawPath: string,
    readonly config: AsyncResearchConfig,
    private readonly providerFactory?: ResearchProviderFactory,
  ) {
    if (
      resolve(rawPath) === resolve(config.databasePath) ||
      (existsSync(config.databasePath) &&
        realpathSync(rawPath) === realpathSync(config.databasePath))
    )
      throw new Error('Research database must be separate from raw history');
    this.queue = new ResearchQueue(config.databasePath);
    this.evidence = new EvidenceBuilder(rawPath, config.databasePath);
    this.advice = new AdviceStore(config.databasePath);
    this.controls = new AsyncControlStore(config.databasePath);
  }
  status(): AsyncResearchStatus {
    const control = this.controls.get();
    return {
      ...this.queue.status(),
      configuredMode: this.config.mode,
      mode: effectiveResearchMode(this.config.mode, control),
      running: this.active,
      liveConfirmed: control?.liveConfirmed ?? false,
      lastTickAt: this.lastTickAt,
      error: this.error,
    };
  }
  async tick(signal?: AbortSignal): Promise<AsyncResearchStatus> {
    if (this.active) return this.status();
    if (this.status().mode === 'off') return this.status();
    this.active = true;
    this.error = null;
    try {
      this.deliver();
      for (const batch of this.evidence.batches()) {
        this.advice.refreshEvidence(batch);
        const threshold =
          batch.taskType === 'opponent_brief'
            ? this.config.minNewHands
            : this.config.leakMinNewHands;
        const evaluation = this.queue.scheduler.evaluate(
          batch,
          threshold,
          batch.taskType === 'opponent_brief'
            ? (this.config.initialMinHands ?? Math.min(10, threshold))
            : threshold,
        );
        if (evaluation.eligible) {
          const id = this.queue.enqueue(
            batch,
            `${this.config.provider}:${this.config.model}`,
            this.config.maxPending,
            evaluation.entry.updatedAt,
            evaluation.priority,
          );
          if (!id)
            evaluation.entry.reason = this.queue.db
              .prepare(
                "SELECT 1 FROM research_jobs WHERE task_type=? AND scope_key=? AND state='pending'",
              )
              .get(batch.taskType, batch.scopeKey)
              ? 'pending_evidence_preserved'
              : 'queue_capacity';
        }
        this.queue.scheduler.save(evaluation.entry);
      }
      const job = this.queue.claim(this.owner, this.config.jobTimeoutMs);
      if (!job) return this.status();
      const abort = new AbortController();
      const timer = AbortSignal.timeout(this.config.jobTimeoutMs);
      const combined = AbortSignal.any([abort.signal, timer, ...(signal ? [signal] : [])]);
      const heartbeat = setInterval(
        () => {
          try {
            if (this.status().mode === 'off' || !this.queue.heartbeat(job))
              abort.abort(new Error('research_lease_or_mode_changed'));
          } catch {
            abort.abort(new Error('research_heartbeat_failed'));
          }
        },
        Math.min(3000, Math.max(10, this.config.intervalMs)),
      );
      try {
        const meter = this.queue.meter(job, this.config);
        const provider =
          this.providerFactory?.(meter) ?? new LlmResearchProvider(this.config, meter);
        const result = await provider.propose(job.batch, combined);
        combined.throwIfAborted();
        // First durably commit a generation-guarded outbox; late old responses cannot become proposals.
        if (this.queue.finish(job, 'completed', result)) this.deliver();
      } catch (error) {
        const code = combined.aborted ? 'research_cancelled' : 'research_failed';
        this.queue.finish(job, combined.aborted ? 'cancelled' : 'failed', { code }, code);
        this.error = code;
        // Provider diagnostics are private in attempts; never forward arbitrary upstream text to web UI.
        if (
          error instanceof Error &&
          /key and model are required|Unsupported DeepSeek model/.test(error.message)
        )
          this.error = 'research_configuration_error';
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.active = false;
      this.lastTickAt = new Date().toISOString();
    }
    return this.status();
  }
  private deliver(): void {
    for (const { job, outcome } of this.queue.completedUndelivered()) {
      const result = outcome as ResearchResponse;
      if (result.insufficient) {
        this.queue.delivered(job.id);
        continue;
      }
      try {
        const record = this.advice.ingest(job.batch, result.raw, result.model);
        if (
          this.config.publishPolicy === 'approved_recipe' &&
          record.status === 'pending' &&
          record.proposal.proposedRecipeId
        ) {
          const topic = contentHash({ kind: record.proposal.kind, scope: record.proposal.scope });
          const revision = Number(
            this.advice.db
              .prepare(
                'SELECT MAX(revision) AS revision FROM advice_publications WHERE topic_key=?',
              )
              .get(topic)?.revision ?? 0,
          );
          try {
            this.advice.publishApprovedRecipe(record.proposalId, {
              expectedRevision: revision,
              ttlMs: 86400000,
              actor: 'approved-recipe-publisher',
            });
          } catch {
            /* Pending manual review or CAS/TTL failure is not an inference failure. */
          }
        }
        this.queue.delivered(job.id);
      } catch (error) {
        // Schema/evidence rejection is durably audited by AdviceStore. Transient SQLite failures retry outbox.
        if (
          error instanceof Error &&
          /SQLITE|database is locked|database is busy/i.test(error.message)
        )
          throw error;
        this.queue.delivered(job.id);
        this.error = 'research_proposal_rejected';
      }
    }
  }
  close(): void {
    this.evidence.close();
    this.controls.close();
    this.advice.close();
    this.queue.close();
  }
}
