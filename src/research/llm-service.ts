import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { AdviceStore } from '../knowledge/advice-store.js';
import type { AdviceBundle, PublishedAdvice } from '../knowledge/advice-types.js';
import { AsyncControlStore, effectiveResearchMode } from './control.js';
import { ResearchQueue } from './queue.js';
import type { AsyncResearchConfig } from './config.js';
import type { AsyncResearchStatus } from './engine.js';
/** Independent supervisor: credentials are allowlisted config, inherited process environment is empty. */
export class AsyncResearchService extends EventEmitter {
  private worker: Worker | null = null;
  private stopped = true;
  private stopping: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private failures = 0;
  private advice: AdviceStore | null = null;
  private controls: AsyncControlStore | null = null;
  private queue: ResearchQueue | null = null;
  private lastTickAt: string | null = null;
  private error: string | null = null;
  constructor(
    private readonly rawPath: string,
    readonly config: AsyncResearchConfig,
  ) {
    super();
  }
  private readers(): void {
    this.advice ??= new AdviceStore(this.config.databasePath);
    this.controls ??= new AsyncControlStore(this.config.databasePath);
    this.queue ??= new ResearchQueue(this.config.databasePath);
  }
  mode(): AsyncResearchConfig['mode'] {
    this.readers();
    return effectiveResearchMode(this.config.mode, this.controls!.get());
  }
  bundle(options: {
    mode: AsyncResearchConfig['mode'];
    basePolicyVersion: string;
    admissibleAt: string;
  }): AdviceBundle {
    this.readers();
    return this.advice!.bundle({ ...options, maxItems: this.config.maxItems });
  }
  latest(asOf = new Date().toISOString()): PublishedAdvice[] {
    return this.bundle({
      mode: this.mode(),
      basePolicyVersion: 'poker-knowledge-base-v1',
      admissibleAt: asOf,
    }).publications;
  }
  status(): AsyncResearchStatus {
    this.readers();
    const control = this.controls!.get();
    return {
      ...this.queue!.status(),
      configuredMode: this.config.mode,
      mode: effectiveResearchMode(this.config.mode, control),
      running: this.worker !== null,
      liveConfirmed: control?.liveConfirmed ?? false,
      lastTickAt: this.lastTickAt,
      error: this.error,
    };
  }
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    this.readers();
    this.stopped = false;
    if (this.config.mode === 'off' || this.worker || this.restartTimer) return;
    this.launch();
  }
  private launch(): void {
    if (this.stopped || this.worker) return;
    const generation = ++this.generation;
    try {
      const entry = new URL('./llm-worker-entry.js', import.meta.url);
      const options = {
        env: {},
        execArgv: [],
        workerData: { rawPath: this.rawPath, config: this.workerConfig() },
      };
      const worker = existsSync(entry)
        ? new Worker(entry, options)
        : new Worker(
            `require('tsx/cjs'); require(${JSON.stringify(fileURLToPath(new URL('./llm-worker-entry.ts', import.meta.url)))});`,
            { ...options, eval: true },
          );
      this.worker = worker;
      let failed = false;
      const fail = () => {
        if (failed || this.stopped || generation !== this.generation) return;
        failed = true;
        this.error = 'Research worker failed; fast decisions and statistics continue.';
        this.emit('update');
      };
      worker.on('message', (message: { type: string; status?: AsyncResearchStatus }) => {
        if (this.stopped || generation !== this.generation) return;
        if (message.type === 'progress' && message.status) {
          this.lastTickAt = message.status.lastTickAt;
          this.error = message.status.error;
          this.failures = 0;
        } else if (message.type === 'failure')
          this.error = 'Research batch failed; durable queue retained.';
        this.emit('update');
      });
      worker.on('error', fail);
      // Restart only once the previous worker exited; error+exit cannot spawn two publishers.
      worker.on('exit', () => {
        if (generation !== this.generation) return;
        if (this.worker === worker) this.worker = null;
        if (!this.stopped) {
          fail();
          this.scheduleRestart();
        }
      });
    } catch {
      this.error = 'Research worker could not start.';
      this.scheduleRestart();
      this.emit('update');
    }
  }
  private workerConfig(): AsyncResearchConfig {
    // Construct explicitly: accidental AppConfig spreading cannot give the worker arena/Jev keys.
    const c = this.config;
    return {
      mode: c.mode,
      databasePath: c.databasePath,
      publishPolicy: c.publishPolicy,
      maxItems: c.maxItems,
      provider: c.provider,
      protocol: c.protocol,
      apiKey: c.apiKey,
      baseUrl: c.baseUrl,
      model: c.model,
      thinking: c.thinking,
      effort: c.effort,
      maxOutputTokens: c.maxOutputTokens,
      timeoutMs: c.timeoutMs,
      jobTimeoutMs: c.jobTimeoutMs,
      maxRetries: c.maxRetries,
      maxConcurrency: c.maxConcurrency,
      maxPending: c.maxPending,
      minNewHands: c.minNewHands,
      leakMinNewHands: c.leakMinNewHands,
      intervalMs: c.intervalMs,
      inputPricePerMillion: c.inputPricePerMillion,
      outputPricePerMillion: c.outputPricePerMillion,
      cacheReadPricePerMillion: c.cacheReadPricePerMillion,
      cacheCreationPricePerMillion: c.cacheCreationPricePerMillion,
    };
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
    if (worker)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void worker.terminate().then(
            () => resolve(),
            () => resolve(),
          );
        }, 2000);
        worker.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        if (worker.threadId === -1) {
          clearTimeout(timer);
          resolve();
        } else {
          try {
            worker.postMessage('stop');
          } catch {
            void worker.terminate().then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              () => {
                clearTimeout(timer);
                resolve();
              },
            );
          }
        }
      });
    this.generation++;
    this.worker = null;
    this.advice?.close();
    this.advice = null;
    this.controls?.close();
    this.controls = null;
    this.queue?.close();
    this.queue = null;
  }
}
