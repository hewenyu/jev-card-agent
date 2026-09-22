import { parentPort, workerData } from 'node:worker_threads';
import { ResearchEngine } from './engine.js';
import type { AsyncResearchConfig } from './config.js';
const { rawPath, config } = workerData as { rawPath: string; config: AsyncResearchConfig };
const engine = new ResearchEngine(rawPath, config);
const abort = new AbortController();
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let ticking = false;
function close(): void {
  engine.close();
  parentPort?.close();
}
async function tick(): Promise<void> {
  if (stopped) return;
  ticking = true;
  try {
    parentPort?.postMessage({ type: 'progress', status: await engine.tick(abort.signal) });
  } catch {
    parentPort?.postMessage({
      type: 'failure',
      error: 'Research batch failed; durable queue retained.',
    });
  } finally {
    ticking = false;
  }
  if (stopped) close();
  else timer = setTimeout(() => void tick(), config.intervalMs);
}
parentPort?.on('message', (message: unknown) => {
  if (message !== 'stop' || stopped) return;
  stopped = true;
  clearTimeout(timer);
  abort.abort(new Error('research_stopped'));
  if (!ticking) close();
});
void tick();
