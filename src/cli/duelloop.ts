import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FixtureDecisionModel, JevDecisionModel } from 'duelloop';
import { prepareReplayPlan, validateReplayPlan } from '../duelloop/plan.js';
import { runReplayPlan, writePrivateJson } from '../duelloop/run.js';
import { sdkBaseUrl } from '../duelloop/config.js';
import { argumentsFor, fail, numberArg } from './args.js';

async function main(): Promise<void> {
  const args = argumentsFor({
    op: { type: 'string' },
    database: { type: 'string' },
    'run-id': { type: 'string' },
    limit: { type: 'string', default: '24' },
    output: { type: 'string' },
    plan: { type: 'string' },
    model: { type: 'string' },
    'allow-paid': { type: 'boolean', default: false },
    'decision-timeout-ms': { type: 'string', default: '40000' },
    help: { type: 'boolean', default: false },
  });
  if (args.help) {
    console.log(`DuelLoop on archived OpenPoker decisions (no Arena connection):
  --op prepare --database data/jev.sqlite --run-id RUN --output data/duelloop/plan.json [--limit 24]
  --op fixture --plan data/duelloop/plan.json --output data/duelloop/fixture-run
  --op run --plan data/duelloop/plan.json --output data/duelloop/real-run --allow-paid [--model jev-1.13.0]
Preparation reads history only. Fixture uses synthetic Score answers on frozen inputs.
Run requires JEV_API_KEY and uses JEV_BASE_URL / JEV_MODEL / JEV_TIMEOUT_MS.
Output paths must be new. Full reports are private; summary.json contains aggregates.`);
    return;
  }
  if (!['prepare', 'fixture', 'run'].includes(String(args.op)))
    throw new Error('Use --op prepare, fixture or run; see --help');
  if (typeof args.output !== 'string' || !args.output.trim())
    throw new Error('--output is required');
  const output = resolve(args.output);
  if (args.op === 'prepare') {
    if (typeof args['run-id'] !== 'string') throw new Error('--run-id is required');
    const plan = prepareReplayPlan({
      rawPath:
        typeof args.database === 'string'
          ? args.database
          : (process.env.DATABASE_PATH ?? 'data/jev.sqlite'),
      runId: args['run-id'],
      limit: numberArg(args.limit, 24, 'limit'),
    });
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writePrivateJson(output, plan);
    console.log(
      JSON.stringify(
        {
          path: output,
          planHash: plan.planHash,
          samples: plan.samples.length,
          scanned: plan.scanned,
          excluded: plan.excluded,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (typeof args.plan !== 'string') throw new Error('--plan is required');
  const plan = validateReplayPlan(JSON.parse(readFileSync(args.plan, 'utf8')));
  if (args.op === 'run' && args['allow-paid'] !== true)
    throw new Error('Real model requests require --allow-paid');
  const requestedModel =
    typeof args.model === 'string' ? args.model : (process.env.JEV_MODEL ?? 'jev-1.13.0');
  const baseURL = process.env.JEV_BASE_URL ?? 'https://api.typesafe.ai';
  const model =
    args.op === 'fixture'
      ? new FixtureDecisionModel('poker-shadow-wiring-fixture-v1', (question) => ({
          score: 2,
          confidence: 1,
          probabilities: Object.fromEntries(
            question.criteria.map((_, index) => [String(index), index === 2 ? 1 : 0]),
          ),
        }))
      : new JevDecisionModel({
          model: requestedModel,
          apiKeyEnv: 'JEV_API_KEY',
          baseURL: sdkBaseUrl(baseURL),
          timeoutMs: numberArg(process.env.JEV_TIMEOUT_MS, 10000, 'JEV_TIMEOUT_MS'),
        });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const report = await runReplayPlan({
      plan,
      model,
      outputDirectory: output,
      decisionTimeoutMs: numberArg(args['decision-timeout-ms'], 40000, 'decision-timeout-ms'),
      signal: abort.signal,
    });
    console.log(JSON.stringify({ path: output, ...report.summary }, null, 2));
    if (report.summary.failed || report.summary.notRun) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
void main().catch(fail);
