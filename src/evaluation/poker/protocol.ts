import { digest, validateProtocol, type EvaluationProtocol } from 'duelloop';
import { OPPONENT_SUITES, OPPONENT_SUITE_VERSION } from './opponents.js';
import { POKER_SIMULATOR_VERSION } from './engine.js';

export interface PokerEvaluationRules {
  version: typeof POKER_SIMULATOR_VERSION;
  opponentSuiteVersion: typeof OPPONENT_SUITE_VERSION;
  smallBlind: number;
  bigBlind: number;
  startingStacks: number[];
}
export const DEFAULT_EVALUATION_RULES: PokerEvaluationRules = {
  version: POKER_SIMULATOR_VERSION,
  opponentSuiteVersion: OPPONENT_SUITE_VERSION,
  smallBlind: 5,
  bigBlind: 10,
  startingStacks: [1000, 1000, 1000, 1000, 1000, 1000],
};

export function validateEvaluationRules(rules: PokerEvaluationRules): PokerEvaluationRules {
  if (
    rules.version !== POKER_SIMULATOR_VERSION ||
    rules.opponentSuiteVersion !== OPPONENT_SUITE_VERSION ||
    rules.startingStacks.length !== 6 ||
    rules.startingStacks.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    !Number.isSafeInteger(rules.startingStacks.reduce((a, b) => a + b, 0)) ||
    !Number.isSafeInteger(rules.smallBlind) ||
    !Number.isSafeInteger(rules.bigBlind) ||
    rules.smallBlind <= 0 ||
    rules.bigBlind < rules.smallBlind
  )
    throw new Error('Unsupported evaluation rules');
  return structuredClone(rules);
}

/** No hidden threshold defaults: callers lock their protocol before looking at outcomes. */
export function validatePokerProtocols(
  development: EvaluationProtocol,
  final: EvaluationProtocol,
): void {
  for (const protocol of [development, final]) {
    validateProtocol(protocol);
    if (protocol.knowledgeStateMode !== 'frozen')
      throw new Error('Poker evaluation requires frozen knowledge');
    if (
      protocol.metric.name !== 'net_chips' ||
      protocol.metric.unit !== 'bb/100' ||
      protocol.metric.direction !== 'maximize'
    )
      throw new Error('Poker protocol metric must be net_chips, bb/100, maximize');
    if (protocol.opponentIds.some((id) => !OPPONENT_SUITES[id]))
      throw new Error('Unknown versioned opponent suite');
  }
  if (
    development.domainId !== final.domainId ||
    development.id === final.id ||
    development.holdoutId === final.holdoutId ||
    development.seeds.some((seed) => final.seeds.includes(seed))
  )
    throw new Error('Development and final holdout must be disjoint');
  const behavior = (p: EvaluationProtocol) => ({
    domain: p.domainId,
    opponents: p.opponentIds,
    trajectories: p.trajectoriesPerSeed,
    knowledge: p.initialKnowledge,
    knowledgeStateMode: p.knowledgeStateMode,
    metric: p.metric,
  });
  if (digest(behavior(development)) !== digest(behavior(final)))
    throw new Error('Development and final experimental conditions differ');
}

/** Diagnostic pilot only. Four seed blocks cannot meet minSamples=30 or qualify a release. */
export function createPokerPilotProtocols(
  domainId: string,
  maxP95DecisionComputeMs: number,
): {
  development: EvaluationProtocol;
  final: EvaluationProtocol;
} {
  const common = {
    version: '3.0' as const,
    domainId,
    opponentIds: Object.keys(OPPONENT_SUITES),
    trajectoriesPerSeed: 6,
    knowledgeStateMode: 'frozen' as const,
    initialKnowledge: {},
    metric: { name: 'net_chips', unit: 'bb/100', direction: 'maximize' as const },
    minSamples: 30,
    minimumImprovement: 0,
    maxGroupRegression: 25,
    confidenceLevel: 0.95,
    maxP95DecisionComputeMs,
    maxDevelopmentEvalRuns: 2,
    maxFinalEvaluationsPerRun: 1,
    maxHoldoutUses: 1,
  };
  const development: EvaluationProtocol = {
    ...structuredClone(common),
    id: 'poker-pilot-development-v1',
    seeds: [1101, 1102, 1103, 1104],
    holdoutId: 'poker-pilot-development-v1',
  };
  const final: EvaluationProtocol = {
    ...structuredClone(common),
    id: 'poker-pilot-final-v1',
    seeds: [9901, 9902, 9903, 9904],
    holdoutId: 'poker-pilot-final-v1',
  };
  validatePokerProtocols(development, final);
  return { development, final };
}
