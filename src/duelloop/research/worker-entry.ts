import { parentPort, workerData } from 'node:worker_threads';
import { SqliteStore, behaviorDependencies } from 'duelloop';
import { createPokerDomain } from '../../poker/domain.js';
import { createPokerEvaluator } from '../../evaluation/poker/adapter.js';
import { validatePokerProtocols } from '../../evaluation/poker/protocol.js';
import { createLiveModel } from '../live/model.js';
import { createResearchEngine } from './engine.js';
import type { DuelLoopResearchConfig } from './config.js';
import type { ResearchCommand } from './service.js';
import { loadResearchProtocols } from './protocols.js';

const port = parentPort;
if (!port) throw new Error('Research entry requires an isolated worker');
const { storePath, scopeId, config } = workerData as {
  storePath: string;
  scopeId: string;
  config: DuelLoopResearchConfig;
};
const store = new SqliteStore(storePath);
const model = createLiveModel(config.jev, {
  onAttempt: (attempt) => {
    store.appendEvent('research.jev_attempt', scopeId, attempt, 'private');
    model.attempts.splice(0);
  },
  onStart: (attempt) => {
    store.appendEvent('research.jev_request', scopeId, attempt, 'private');
  },
  onLateResult: (attempt) => {
    store.appendEvent('research.jev_late', scopeId, attempt, 'private');
    model.lateResults.splice(0);
  },
});
const domain = createPokerDomain({
  observe: async () => {
    throw new Error('Research worker cannot observe a live table');
  },
  candidates: async () => {
    throw new Error('Research worker cannot query live candidates');
  },
  evaluation: true,
});
const { protocol, developmentProtocol } = loadResearchProtocols(store, scopeId, config);
const engine = createResearchEngine({
  store,
  scopeId,
  config,
  domain,
  model,
  protocol,
  developmentProtocol,
  evaluator: createPokerEvaluator({ domain, decisionPolicy: config.decisionPolicy }),
  dependencies: behaviorDependencies(domain, model, config.decisionPolicy),
});
const controls = store.latestEvent(scopeId, 'research.application_control', { allowPrivate: true })
  ?.data as { paused?: boolean } | undefined;
let paused = controls?.paused ?? false;
let stopping = false;
let busy = false;
let recovered = false;
let current: Promise<void> | null = null;
let error: string | null = null;
const status = () => port.postMessage({ type: 'status', status: engine.status(), paused, error });
const tick = async () => {
  if (busy || paused || stopping) return;
  busy = true;
  try {
    if (!recovered) {
      await engine.recover();
      recovered = true;
    }
    await engine.worker.tick();
    error = null;
  } catch {
    error = 'Research task failed; inspect its durable SDK run record.';
  } finally {
    busy = false;
    status();
  }
};
async function command(command: ResearchCommand): Promise<unknown> {
  if (command.type === 'pause') {
    paused = command.paused;
    store.appendEvent('research.application_control', scopeId, { paused }, 'private');
    status();
    return { paused };
  }
  if (command.type === 'cancel') return engine.cancel(command.runId);
  if (command.type === 'recover') {
    if (busy) throw new Error('Research task is currently executing');
    busy = true;
    try {
      return await engine.recover();
    } finally {
      busy = false;
      status();
    }
  }
  validatePokerProtocols(command.developmentProtocol, command.protocol);
  engine.worker.updateProtocols(command);
  const artifact = store.putArtifact('research.configured_protocols', command, 'private');
  store.appendEvent('research.application_protocols', scopeId, { artifact }, 'private');
  return engine.status();
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(heartbeat);
  engine.worker.stop();
  const active = store.activeRun(scopeId);
  if (active) engine.cancel(active.id);
  await current;
  await engine.close();
  store.close();
  port!.close();
}
port.on('message', (message: { type: string; id: string; command: ResearchCommand }) => {
  if (message.type === 'stop') {
    void stop();
    return;
  }
  if (message.type !== 'command') return;
  void command(message.command).then(
    (result) => port.postMessage({ type: 'reply', id: message.id, result }),
    () =>
      port.postMessage({
        type: 'reply',
        id: message.id,
        error: 'Research command rejected; inspect durable state and scope',
      }),
  );
});
const poll = () => {
  if (!busy && !stopping) {
    current = tick();
    void current;
  }
};
const timer = setInterval(poll, config.pollIntervalMs);
const heartbeat = setInterval(status, Math.min(5000, config.pollIntervalMs));
status();
poll();
