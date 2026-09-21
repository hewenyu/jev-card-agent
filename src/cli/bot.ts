import { loadConfig } from '../server/config.js';
import { Controller } from '../server/controller.js';
import { Store } from '../storage/store.js';
import { argumentsFor, fail, numberArg } from './args.js';

async function main(): Promise<void> {
  const args = argumentsFor({
    strategy: { type: 'string', default: 'jev' },
    'max-hands': { type: 'string', default: '0' },
    'max-minutes': { type: 'string', default: '0' },
    'buy-in': { type: 'string', default: '2000' },
    'no-auto-rebuy': { type: 'boolean', default: false },
  });
  if (args.strategy !== 'jev' && args.strategy !== 'baseline' && args.strategy !== 'jev-reasoning')
    throw new Error('--strategy must be jev, baseline or jev-reasoning');
  const config = loadConfig();
  const store = new Store(config.databasePath, config.jevModel);
  const controller = new Controller(config, store);
  let signalCount = 0;
  const shutdown = () => {
    signalCount++;
    controller.stop(signalCount === 1);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const result = await controller.start({
      strategy: args.strategy,
      maxHands: numberArg(args['max-hands'], 0, 'max-hands'),
      maxMinutes: numberArg(args['max-minutes'], 0, 'max-minutes'),
      buyIn: numberArg(args['buy-in'], 2000, 'buy-in'),
      autoRebuy: args['no-auto-rebuy'] !== true,
    });
    process.stdout.write(
      `${JSON.stringify({ event: 'started', runId: result.runId, strategy: result.strategy })}\n`,
    );
    const runtime = controller.runtime;
    if (!runtime) throw new Error('Runtime did not initialize');
    runtime.on(
      'decision',
      (decision: {
        id: string;
        handId: string;
        proposal: { source: string; candidateId: string };
      }) => {
        process.stdout.write(
          `${JSON.stringify({ event: 'decision', id: decision.id, handId: decision.handId, source: decision.proposal.source, selected: decision.proposal.candidateId })}\n`,
        );
      },
    );
    if (!['failed', 'stopped'].includes(runtime.status().phase))
      await new Promise<void>((resolve) => runtime.once('stopped', resolve));
    const status = runtime.status();
    process.stdout.write(
      `${JSON.stringify({ event: 'stopped', runId: status.runId, status: status.phase, hands: status.hands, decisions: status.decisions, error: status.lastError })}\n`,
    );
    if (status.phase === 'failed') process.exitCode = 1;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await controller.close();
    store.close();
  }
}
void main().catch(fail);
