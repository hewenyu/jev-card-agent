import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { FactsStore, emptyFactsSnapshot } from './store.js';
import { DatabaseSync } from 'node:sqlite';
import type { AuditView, KnowledgeSnapshot, SlowLoopStatus } from '../knowledge/types.js';

export interface FactsOptions {
  enabled?: boolean;
  intervalMs?: number;
  batchSize?: number;
  legacyAuditPath?: string;
}
/** Only paths and numeric settings cross the worker boundary; environment and credentials do not. */
export class FactsService extends EventEmitter {
  private worker: Worker | null = null;
  private stopped = true;
  private stopping: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private failures = 0;
  private reader: FactsStore | null = null;
  private snapshot = emptyFactsSnapshot();
  private legacyAudit: DatabaseSync | null = null;
  private current: SlowLoopStatus;
  constructor(
    private readonly rawPath: string,
    private readonly derivedPath: string,
    private readonly options: FactsOptions = {},
  ) {
    super();
    this.current = {
      enabled: options.enabled !== false,
      running: false,
      lastCompletedAt: null,
      eventCursor: 0,
      decisionCursor: 0,
      pendingHands: 0,
      pendingAudits: 0,
      latestVersion: this.snapshot.version,
      error: null,
    };
  }
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    this.openReader();
    this.stopped = false;
    if (!this.current.enabled || this.worker || this.restartTimer) return;
    this.launch();
  }
  private launch(): void {
    if (this.stopped || this.worker) return;
    const generation = ++this.generation;
    try {
      // Existing facts is safe to load before worker startup; no raw database writes occur here.
      this.openReader();
      const entry = new URL('./worker-entry.js', import.meta.url);
      const isSource = !existsSync(entry);
      // tsx's loader is explicitly registered only in source development; inherited execArgv can contain --env-file.
      const worker = isSource
        ? new Worker(
            `require('tsx/cjs'); require(${JSON.stringify(fileURLToPath(new URL('./worker-entry.ts', import.meta.url)))});`,
            { eval: true, env: {}, execArgv: [], workerData: this.workerOptions() },
          )
        : new Worker(entry, { env: {}, execArgv: [], workerData: this.workerOptions() });
      this.worker = worker;
      this.current = { ...this.current, running: true, error: null };
      let failed = false;
      const fail = () => {
        if (failed || this.stopped || generation !== this.generation) return;
        failed = true;
        this.current = {
          ...this.current,
          running: false,
          error: 'Facts worker failed; decisions continue with available facts.',
        };
        this.emit('update');
      };
      worker.on(
        'message',
        (message: {
          type: string;
          status?: SlowLoopStatus;
          snapshot?: KnowledgeSnapshot;
          error?: string;
        }) => {
          if (this.stopped || generation !== this.generation) return;
          if (message.type === 'progress' && message.status) {
            this.failures = 0;
            this.current = message.status;
            if (
              message.snapshot &&
              message.snapshot.evidenceEventId >= this.snapshot.evidenceEventId
            )
              this.snapshot = message.snapshot;
            this.openReader();
          } else if (message.type === 'failure')
            this.current = {
              ...this.current,
              error: 'Facts batch failed; progress retained for retry.',
            };
          this.emit('update');
        },
      );
      worker.on('error', fail);
      worker.on('exit', () => {
        if (generation !== this.generation) return;
        if (this.worker === worker) this.worker = null;
        this.current = { ...this.current, running: false };
        if (!this.stopped) {
          fail();
          this.scheduleRestart();
        }
      });
    } catch {
      this.current = {
        ...this.current,
        running: false,
        error: 'Facts worker could not start; decisions continue with available facts.',
      };
      this.scheduleRestart();
      this.emit('update');
    }
  }
  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(30000, 250 * 2 ** Math.min(this.failures++, 7));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.launch();
    }, delay);
    this.restartTimer.unref();
  }
  private workerOptions() {
    return {
      rawPath: this.rawPath,
      derivedPath: this.derivedPath,
      intervalMs: this.options.intervalMs ?? 1000,
      batchSize: this.options.batchSize ?? 16,
    };
  }
  private openReader(): void {
    if (this.reader || !existsSync(this.derivedPath)) return;
    try {
      this.reader = new FactsStore(this.derivedPath, { readOnly: true });
      const snapshot = this.reader.latest();
      if (snapshot.evidenceEventId >= this.snapshot.evidenceEventId) this.snapshot = snapshot;
      this.current = { ...this.current, latestVersion: this.snapshot.version };
    } catch {
      this.reader?.close();
      this.reader = null;
    }
  }
  status(): SlowLoopStatus {
    return { ...this.current };
  }
  revision(asOf: string): string {
    const cutoff = Date.parse(asOf);
    if (
      Number.isFinite(cutoff) &&
      Date.parse(this.snapshot.publishedAt) <= cutoff &&
      (!this.snapshot.expiresAt || Date.parse(this.snapshot.expiresAt) > cutoff)
    )
      return this.snapshot.contentHash;
    return this.latest(asOf).contentHash;
  }
  latest(asOf?: string): KnowledgeSnapshot {
    const cutoff = asOf === undefined ? Date.now() : Date.parse(asOf);
    if (!Number.isFinite(cutoff)) return emptyFactsSnapshot();
    if (
      Date.parse(this.snapshot.publishedAt) <= cutoff &&
      (!this.snapshot.expiresAt || Date.parse(this.snapshot.expiresAt) > cutoff)
    ) {
      return structuredClone(this.snapshot);
    }
    // Hand recovery can precede the cached publication. This is an indexed read-only lookup,
    // never a wait for research or an on-demand recomputation of opponent statistics.
    try {
      return this.reader?.latest(new Date(cutoff).toISOString()) ?? emptyFactsSnapshot();
    } catch {
      return emptyFactsSnapshot();
    }
  }
  getAudit(decisionId: string): AuditView | null {
    try {
      const current = this.reader?.getAudit(decisionId);
      if (current) return current;
      const path = this.options.legacyAuditPath;
      if (!path || !existsSync(path)) return null;
      if (!this.legacyAudit) {
        this.legacyAudit = new DatabaseSync(path, { readOnly: true });
        this.legacyAudit.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
      }
      const row = this.legacyAudit
        .prepare('SELECT payload FROM decision_audits WHERE decision_id=?')
        .get(decisionId);
      return row ? (JSON.parse(String(row.payload)) as AuditView) : null;
    } catch {
      return null;
    }
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopWorker();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }
  private async stopWorker(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const worker = this.worker;
    if (worker) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          void worker.terminate().then(
            () => resolve(),
            () => resolve(),
          );
        }, 2000);
        worker.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        if (worker.threadId === -1) {
          clearTimeout(timeout);
          resolve();
        } else {
          try {
            worker.postMessage('stop');
          } catch {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    }
    this.generation++;
    this.worker = null;
    this.reader?.close();
    this.reader = null;
    this.legacyAudit?.close();
    this.legacyAudit = null;
    this.current = { ...this.current, running: false };
  }
}
