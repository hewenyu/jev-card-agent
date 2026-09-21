import { randomUUID } from 'node:crypto';
import { OpenPokerClient } from '../openpoker/client.js';
import { buildCandidates, buildContext, createInitialState } from '../core/index.js';
import { loadConfig, type AppConfig } from '../server/config.js';
import { ledgerFor, policyFor, reasoningFor } from '../server/controller.js';
import { Store } from '../storage/store.js';
import { argumentsFor, fail } from './args.js';

const output = (value: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
async function openPoker(config: AppConfig, store: Store): Promise<void> {
  if (!config.openPokerApiKey) throw new Error('OPEN_POKER_API_KEY is required');
  const client = new OpenPokerClient({
    apiKey: config.openPokerApiKey,
    wsUrl: config.openPokerWsUrl,
    restUrl: config.openPokerRestUrl,
  });
  const active = await client.activeGame();
  output({ check: 'openpoker_rest', status: 'ok', playing: active.playing });
  // A second authenticated WS can replace an active bot connection. Never probe an occupied seat.
  if (active.playing || !store.acquireLease()) {
    output({
      check: 'openpoker_ws',
      status: 'skipped',
      reason: 'bot_already_seated_or_runtime_active',
    });
    return;
  }
  const socket = client.connect();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('OpenPoker handshake timed out'));
      }, 10_000);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        response.resume();
        socket.terminate();
        reject(new Error(`OpenPoker WS HTTP ${response.statusCode}`));
      });
      socket.on('message', (raw) => {
        try {
          const event = JSON.parse(raw.toString()) as { type: string; code?: string };
          if (event.type === 'connected') {
            clearTimeout(timer);
            socket.close();
            resolve();
          } else if (event.type === 'error') {
            clearTimeout(timer);
            socket.close();
            reject(new Error(`OpenPoker WS: ${event.code ?? 'unknown'}`));
          }
        } catch {
          clearTimeout(timer);
          socket.close();
          reject(new Error('Invalid OpenPoker handshake message'));
        }
      });
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error('OpenPoker closed before confirmation'));
      });
    });
    output({ check: 'openpoker_ws', status: 'ok', joinedLobby: false });
  } finally {
    socket.close();
    store.releaseLease();
  }
}
async function main(): Promise<void> {
  const args = argumentsFor({
    jev: { type: 'boolean', default: false },
    reasoning: { type: 'boolean', default: false },
    'skip-openpoker': { type: 'boolean', default: false },
  });
  const config = loadConfig();
  const store = new Store(config.databasePath, config.jevModel);
  try {
    if (!args['skip-openpoker']) await openPoker(config, store);
    const state = {
      ...createInitialState(),
      tableId: 'diagnostic',
      handId: 'diagnostic',
      heroSeat: 0,
      actorSeat: 0,
      holeCards: ['Ah', 'Kd'],
      validActions: [{ action: 'check' as const }, { action: 'fold' as const }],
    };
    const context = buildContext(state);
    const candidates = buildCandidates(state);
    const runId = `diagnostic-${randomUUID()}`;
    if (args.jev) {
      const result = await policyFor(config, 'jev', ledgerFor(config, store, runId)).decide(
        context,
        candidates,
      );
      output({
        check: 'jev',
        status: 'ok',
        model: result.model,
        candidate: result.candidateId,
        latencyMs: result.latencyMs,
        usage: result.usage,
        attempts: result.attempts?.length,
      });
    }
    if (args.reasoning) {
      const result = await reasoningFor(config, ledgerFor(config, store, runId)).analyze(
        context,
        candidates,
      );
      output({
        check: 'reasoning',
        status: 'ok',
        provider: result.attempt.provider,
        configuration: result.attempt.configuration,
        requestedModel: result.requestedModel,
        actualModel: result.actualModel,
        latencyMs: result.attempt.latencyMs,
        usage: result.attempt.usage,
      });
    }
  } finally {
    store.close();
  }
}
void main().catch(fail);
