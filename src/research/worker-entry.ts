import { parentPort, workerData } from 'node:worker_threads';
import { StatsWorker } from './stats-worker.js';
const options = workerData as {
  rawPath: string;
  derivedPath: string;
  intervalMs: number;
  batchSize: number;
};
const worker = new StatsWorker(options.rawPath, options.derivedPath, options.batchSize);
let stopped = false;
let sentVersion: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
function tick() {
  if (stopped) return;
  try {
    const status = worker.tick();
    const snapshot = status.latestVersion !== sentVersion ? worker.knowledge.latest() : undefined;
    parentPort?.postMessage({ type: 'progress', status, ...(snapshot ? { snapshot } : {}) });
    sentVersion = status.latestVersion;
  } catch (error) {
    parentPort?.postMessage({
      type: 'failure',
      error: error instanceof Error ? error.message : 'Slow loop failed',
    });
  }
  timer = setTimeout(tick, options.intervalMs);
}
parentPort?.on('message', (message: unknown) => {
  if (message !== 'stop') return;
  stopped = true;
  clearTimeout(timer);
  worker.close();
  parentPort?.close();
});
tick();
