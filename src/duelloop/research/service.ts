import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { SqliteStore, type EvaluationProtocol } from 'duelloop';
import { researchWorkerConfig, type DuelLoopResearchConfig } from './config.js';
import type { DuelLoopResearchStatus } from './engine.js';
import { loadResearchProtocols } from './protocols.js';

export type ResearchCommand =
  | { type: 'pause'; paused: boolean }
  | { type: 'cancel'; runId: string }
  | { type: 'recover' }
  | { type: 'protocols'; protocol: EvaluationProtocol; developmentProtocol: EvaluationProtocol };
export interface ResearchServiceStatus {
  state?: 'waiting_protocol';
  enabled: boolean;
  running: boolean;
  paused: boolean;
  error: string | null;
  updatedAt: string | null;
  research: DuelLoopResearchStatus | null;
}
/** Isolated research supervisor; it has no action-submission or release-activation endpoint. */
export class DuelLoopResearchService extends EventEmitter {
  private worker: Worker | null = null;
  private stopped = true;
  private stopping: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private generation = 0;
  private state: ResearchServiceStatus;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly storePath: string,
    private readonly scopeId: string,
    readonly config: DuelLoopResearchConfig,
  ) {
    super();
    this.state = {
      enabled: config.enabled,
      running: false,
      paused: false,
      error: null,
      updatedAt: null,
      research: null,
    };
  }
  status(): ResearchServiceStatus {
    return structuredClone(this.state);
  }
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    this.stopped = false;
    if (!this.config.enabled || this.worker || this.restartTimer) return;
    try {
      const reader = new SqliteStore(this.storePath);
      try {
        loadResearchProtocols(reader, this.scopeId, this.config);
      } finally {
        reader.close();
      }
      delete this.state.state;
      this.state.error = null;
    } catch {
      this.state.state = 'waiting_protocol';
      this.state.error =
        'Configure separate valid development and final evaluation protocols, then resume research. Live decisions continue.';
      this.emit('update');
      return;
    }
    this.launch();
  }
  private launch() {
    if (this.stopped || this.worker) return;
    const generation = ++this.generation;
    const entry = new URL('./worker-entry.js', import.meta.url);
    const options = {
      env: {},
      execArgv: [],
      workerData: {
        storePath: this.storePath,
        scopeId: this.scopeId,
        config: researchWorkerConfig(this.config),
      },
    };
    try {
      const worker = existsSync(entry)
        ? new Worker(entry, options)
        : new Worker(
            `import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(new URL('./worker-entry.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)}));`,
            { ...options, eval: true },
          );
      this.worker = worker;
      this.state.running = true;
      worker.on(
        'message',
        (message: {
          type: string;
          id?: string;
          result?: unknown;
          error?: string;
          status?: DuelLoopResearchStatus;
          paused?: boolean;
        }) => {
          if (generation !== this.generation) return;
          if (message.type === 'reply' && message.id) {
            const pending = this.pending.get(message.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(message.id);
              if (message.error) pending.reject(new Error(message.error));
              else pending.resolve(message.result);
            }
          } else if (message.type === 'status' && message.status) {
            this.state = {
              ...this.state,
              running: true,
              paused: message.paused ?? false,
              error: message.error ?? null,
              updatedAt: new Date().toISOString(),
              research: message.status,
            };
            this.failures = 0;
            this.emit('update');
          } else if (message.type === 'failure') {
            this.state.error = 'Research worker failed; live decisions continue.';
            this.emit('update');
          }
        },
      );
      worker.on('error', () => {
        this.state.error = 'Research worker failed; durable SDK records retained.';
        this.emit('update');
      });
      worker.on('exit', () => {
        if (generation !== this.generation) return;
        this.worker = null;
        this.state.running = false;
        this.rejectPending();
        if (!this.stopped) {
          this.state.error = 'Research worker exited; restarting with durable recovery.';
          this.scheduleRestart();
        }
        this.emit('update');
      });
    } catch {
      this.state.error = 'Research worker could not start.';
      this.scheduleRestart();
      this.emit('update');
    }
  }
  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(30000, 250 * 2 ** Math.min(this.failures++, 7));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.launch();
    }, delay);
    this.restartTimer.unref();
  }
  async command(command: ResearchCommand): Promise<unknown> {
    if (command.type === 'pause' && !command.paused && !this.worker) await this.start();
    if (!this.worker || this.stopped)
      return Promise.reject(new Error('Research worker is not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Research command timed out; inspect durable state before retrying'));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ type: 'command', id, command });
    });
  }
  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Research worker exited; inspect durable state'));
    }
    this.pending.clear();
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
  private async stopWorker() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const worker = this.worker;
    if (worker)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void worker.terminate().then(
            () => resolve(),
            () => resolve(),
          );
        }, 5000);
        worker.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        if (worker.threadId === -1) {
          clearTimeout(timer);
          resolve();
        } else worker.postMessage({ type: 'stop' });
      });
    this.generation++;
    this.worker = null;
    this.state.running = false;
    this.rejectPending();
  }
}
