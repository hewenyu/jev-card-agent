import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  workers: [] as Array<{
    emit: (event: string, ...args: unknown[]) => boolean;
    options: Record<string, unknown>;
  }>,
}));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    threadId = 1;
    constructor(
      _entry: unknown,
      public options: Record<string, unknown>,
    ) {
      super();
      state.workers.push(this);
    }
    postMessage(message: unknown) {
      if (message === 'stop') {
        this.threadId = -1;
        queueMicrotask(() => this.emit('exit', 0));
      }
    }
    terminate() {
      this.threadId = -1;
      this.emit('exit', 0);
      return Promise.resolve(0);
    }
  },
}));
import { SlowLoopService } from '../src/research/service.js';
import { AsyncResearchService } from '../src/research/llm-service.js';
import { loadAsyncResearchConfig } from '../src/research/config.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  state.workers.length = 0;
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'research-supervisor-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { raw: join(dir, 'raw.sqlite'), derived: join(dir, 'derived.sqlite') };
}
describe.each(['statistics', 'llm'] as const)('%s supervisor', (kind) => {
  const service = () => {
    const p = paths();
    return kind === 'statistics'
      ? new SlowLoopService(p.raw, p.derived)
      : new AsyncResearchService(
          p.raw,
          loadAsyncResearchConfig(
            { ASYNC_LLM_MODE: 'shadow', LLM_RESEARCH_API_KEY: 'research-only' },
            p.raw,
          ),
        );
  };
  it('deduplicates error/exit and ignores old generation updates', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = service();
    await s.start();
    const first = state.workers[0]!;
    first.emit('error', new Error('private internal details'));
    expect(state.workers).toHaveLength(1);
    first.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(state.workers).toHaveLength(2);
    first.emit('message', {
      type: 'progress',
      status: { running: false, error: 'stale update' },
      snapshot: baselineSnapshot(),
    });
    expect(s.status().error).not.toBe('stale update');
    await s.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(state.workers).toHaveLength(2);
  });
  it('active stop cancels scheduled restart and does not inherit the parent environment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = service();
    await s.start();
    const worker = state.workers[0]!;
    expect(worker.options.env).toEqual({});
    expect(worker.options.execArgv).toEqual([]);
    const options = JSON.stringify(worker.options.workerData);
    expect(options).not.toContain('openPokerApiKey');
    expect(options).not.toContain('jevApiKey');
    if (kind === 'statistics') expect(options).not.toContain('research-only');
    worker.emit('exit', 1);
    await s.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(state.workers).toHaveLength(1);
  });
});
