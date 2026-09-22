import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { KnowledgeStore, baselineSnapshot } from '../knowledge/store.js';
import type { AuditView, KnowledgeSnapshot, SlowLoopStatus } from '../knowledge/types.js';

export interface SlowLoopOptions {
  enabled?: boolean;
  intervalMs?: number;
  batchSize?: number;
}
/** Only paths and numeric settings cross the worker boundary; environment and credentials do not. */
export class SlowLoopService extends EventEmitter {
  private worker: Worker | null = null;
  private reader: KnowledgeStore | null = null;
  private snapshot = baselineSnapshot();
  private current: SlowLoopStatus;
  constructor(
    private readonly rawPath: string,
    private readonly derivedPath: string,
    private readonly options: SlowLoopOptions = {},
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
    this.openReader();
    if (!this.current.enabled || this.worker) return;
    try {
      // Existing knowledge is safe to load before worker startup; no raw database writes occur here.
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
      worker.on(
        'message',
        (message: {
          type: string;
          status?: SlowLoopStatus;
          snapshot?: KnowledgeSnapshot;
          error?: string;
        }) => {
          if (message.type === 'progress' && message.status && message.snapshot) {
            this.current = message.status;
            if (message.snapshot.evidenceEventId >= this.snapshot.evidenceEventId)
              this.snapshot = message.snapshot;
            this.openReader();
          } else if (message.type === 'failure')
            this.current = {
              ...this.current,
              error: 'Slow loop batch failed; progress retained for retry.',
            };
          this.emit('update');
        },
      );
      worker.on('error', () => {
        this.current = {
          ...this.current,
          running: false,
          error: 'Slow loop worker failed; decisions continue with published knowledge.',
        };
        this.emit('update');
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        this.current = {
          ...this.current,
          running: false,
          error: code ? `Slow worker exited ${code}` : this.current.error,
        };
        this.emit('update');
      });
    } catch {
      this.current = {
        ...this.current,
        running: false,
        error: 'Slow worker could not start; decisions continue with published knowledge.',
      };
      this.emit('update');
    }
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
      this.reader = new KnowledgeStore(this.derivedPath, { readOnly: true });
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
  latest(asOf?: string): KnowledgeSnapshot {
    const cutoff = asOf === undefined ? Date.now() : Date.parse(asOf);
    if (!Number.isFinite(cutoff)) return baselineSnapshot();
    if (
      Date.parse(this.snapshot.publishedAt) <= cutoff &&
      (!this.snapshot.expiresAt || Date.parse(this.snapshot.expiresAt) > cutoff)
    ) {
      return structuredClone(this.snapshot);
    }
    // Hand recovery can precede the cached publication. This is an indexed read-only lookup,
    // never a wait for research or an on-demand recomputation of opponent statistics.
    try {
      return this.reader?.latest(new Date(cutoff).toISOString()) ?? baselineSnapshot();
    } catch {
      return baselineSnapshot();
    }
  }
  getAudit(decisionId: string): AuditView | null {
    try {
      return this.reader?.getAudit(decisionId) ?? null;
    } catch {
      return null;
    }
  }
  async stop(): Promise<void> {
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
    this.worker = null;
    this.reader?.close();
    this.reader = null;
    this.current = { ...this.current, running: false };
  }
}
