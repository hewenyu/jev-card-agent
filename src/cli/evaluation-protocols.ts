import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import type { EvaluationProtocol } from 'duelloop';
import { validatePokerProtocols } from '../evaluation/poker/protocol.js';
import { OPPONENT_SUITES } from '../evaluation/poker/opponents.js';
import { POKER_DOMAIN_ID } from '../poker/domain.js';

/** Explicit immutable experiment parameters; never reduce thresholds after final results. */
export function prepareEvaluationProtocols(args: Record<string, string | boolean | undefined>) {
  const required = (name: string) => {
    const value = args[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
    return value;
  };
  const numeric = (name: string) => {
    const value = Number(required(name));
    if (!Number.isFinite(value)) throw new Error(`Invalid --${name}`);
    return value;
  };
  const seeds = (name: string) =>
    required(name)
      .split(',')
      .map((v) => {
        const n = Number(v.trim());
        if (!Number.isSafeInteger(n)) throw new Error(`Invalid --${name}`);
        return n;
      });
  const id = randomUUID();
  const common = {
    version: '3.0' as const,
    domainId: POKER_DOMAIN_ID,
    opponentIds: Object.keys(OPPONENT_SUITES),
    trajectoriesPerSeed: numeric('hands-per-seed'),
    knowledgeStateMode: 'frozen' as const,
    initialKnowledge: {},
    metric: { name: 'net_chips', unit: 'bb/100', direction: 'maximize' as const },
    minSamples: numeric('min-samples'),
    minimumImprovement: numeric('minimum-improvement'),
    maxGroupRegression: numeric('max-group-regression'),
    confidenceLevel: numeric('confidence'),
    maxP95DecisionComputeMs: numeric('max-latency-ms'),
    maxDevelopmentEvalRuns: 2,
    maxFinalEvaluationsPerRun: 1,
    maxHoldoutUses: 1,
  };
  const count = args['seed-blocks'] === undefined ? common.minSamples : numeric('seed-blocks');
  if (!Number.isSafeInteger(count) || count < 2 || count > 100000)
    throw new Error('seed-blocks must be an integer from 2 to 100000');
  if (Boolean(args['development-seeds']) !== Boolean(args['final-seeds']))
    throw new Error('Explicit seed lists require both partitions');
  const used = new Set<number>();
  const fresh = () =>
    Array.from({ length: count }, () => {
      let n: number;
      do {
        n = randomInt(0, 2 ** 32);
      } while (used.has(n));
      used.add(n);
      return n;
    });
  const development: EvaluationProtocol = {
    ...structuredClone(common),
    id: `${id}-development`,
    holdoutId: `${id}-development`,
    seeds: args['development-seeds'] ? seeds('development-seeds') : fresh(),
  };
  const final: EvaluationProtocol = {
    ...structuredClone(common),
    id: `${id}-final`,
    holdoutId: `${id}-final`,
    seeds: args['final-seeds'] ? seeds('final-seeds') : fresh(),
  };
  validatePokerProtocols(development, final);
  if (development.seeds.length < common.minSamples || final.seeds.length < common.minSamples)
    throw new Error(
      'Formal protocols need at least min-samples independent seeds in both partitions',
    );
  const directory = resolve(required('output'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const paths = {
    development: join(directory, 'development.json'),
    final: join(directory, 'final.json'),
  };
  for (const [key, protocol] of [
    ['development', development],
    ['final', final],
  ] as const)
    writeFileSync(paths[key], JSON.stringify(protocol, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
  return {
    ...paths,
    id,
    independentSamples: { development: development.seeds.length, final: final.seeds.length },
    note: 'Locked plan only; profitability not yet evaluated. Keep final seeds private.',
  };
}
