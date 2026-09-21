import { randomUUID } from 'node:crypto';
import { evaluateRun } from '../evaluation/service.js';
import { loadConfig } from '../server/config.js';
import { policyFor, ledgerFor } from '../server/controller.js';
import { Store } from '../storage/store.js';
import { argumentsFor, fail, numberArg } from './args.js';

async function main(): Promise<void> {
  const args = argumentsFor({
    run: { type: 'string' },
    strategy: { type: 'string', default: 'baseline' },
    limit: { type: 'string', default: '50' },
    demo: { type: 'boolean', default: false },
  });
  if (typeof args.run !== 'string' || !args.run) throw new Error('--run RUN_ID is required');
  if (args.strategy !== 'baseline' && args.strategy !== 'jev' && args.strategy !== 'jev-reasoning')
    throw new Error('--strategy must be baseline, jev or jev-reasoning');
  const config = loadConfig(process.env, args.demo === true);
  const store = new Store(config.databasePath, config.jevModel);
  try {
    const evaluationId = randomUUID();
    const meter =
      args.strategy !== 'baseline'
        ? ledgerFor(config, store, `evaluation-${evaluationId}`)
        : undefined;
    const result = await evaluateRun(
      store,
      args.run,
      args.strategy,
      numberArg(args.limit, 50, 'limit'),
      policyFor(config, args.strategy, meter),
      {
        id: evaluationId,
        timeoutMs:
          args.strategy === 'jev-reasoning' ? config.hybridTimeoutMs : config.jevDecisionTimeoutMs,
      },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    store.close();
  }
}
void main().catch(fail);
