import { describe, expect, it } from 'vitest';
import type { EvaluationProtocol } from 'duelloop';
import {
  DEFAULT_EVALUATION_RULES,
  validateEvaluationRules,
  validatePokerProtocols,
} from '../src/evaluation/poker/protocol.js';
import { EvaluationUsage } from '../src/evaluation/poker/usage.js';

function protocol(id: string, seeds: number[]): EvaluationProtocol {
  return {
    version: '3.0',
    id,
    domainId: 'openpoker-six-max',
    seeds,
    opponentIds: ['mixed-v1', 'value-heavy-v1', 'pressure-heavy-v1'],
    trajectoriesPerSeed: 6,
    knowledgeStateMode: 'frozen',
    initialKnowledge: {},
    metric: { name: 'net_chips', unit: 'bb/100', direction: 'maximize' },
    minSamples: 2,
    minimumImprovement: 1,
    maxGroupRegression: 10,
    confidenceLevel: 0.95,
    maxP95DecisionComputeMs: 1000,
    maxDevelopmentEvalRuns: 2,
    maxFinalEvaluationsPerRun: 1,
    holdoutId: id,
    maxHoldoutUses: 1,
  };
}
describe('locked poker protocols', () => {
  it('allows matching immutable conditions with independent development/final blocks', () => {
    expect(() =>
      validatePokerProtocols(protocol('dev', [1, 2]), protocol('final', [3, 4])),
    ).not.toThrow();
  });
  it('rejects seed reuse, holdout reuse, unsupported metrics and changing the experiment after development', () => {
    const dev = protocol('dev', [1, 2]);
    expect(() => validatePokerProtocols(dev, protocol('final', [2, 3]))).toThrow('disjoint');
    const final = protocol('final', [3, 4]);
    final.holdoutId = 'dev';
    expect(() => validatePokerProtocols(dev, final)).toThrow('disjoint');
    final.holdoutId = 'final';
    final.metric.unit = 'chips';
    expect(() => validatePokerProtocols(dev, final)).toThrow('metric');
    final.metric.unit = 'bb/100';
    final.trajectoriesPerSeed = 12;
    expect(() => validatePokerProtocols(dev, final)).toThrow('conditions differ');
  });
  it('rejects unimplemented online-update semantics and unknown benchmark populations', () => {
    const final = protocol('final', [3, 4]);
    final.knowledgeStateMode = 'online_update';
    expect(() => validatePokerProtocols(protocol('dev', [1, 2]), final)).toThrow('frozen');
    final.knowledgeStateMode = 'frozen';
    final.opponentIds = ['invented'];
    expect(() => validatePokerProtocols(protocol('dev', [1, 2]), final)).toThrow('Unknown');
  });
  it('rejects invalid chip arithmetic and clones caller-owned rules', () => {
    expect(() =>
      validateEvaluationRules({
        ...DEFAULT_EVALUATION_RULES,
        startingStacks: Array(6).fill(Number.MAX_SAFE_INTEGER),
      }),
    ).toThrow('Unsupported');
    const rules = validateEvaluationRules(DEFAULT_EVALUATION_RULES);
    rules.startingStacks[0] = 2;
    expect(DEFAULT_EVALUATION_RULES.startingStacks[0]).toBe(1000);
  });
});
describe('evaluation usage completeness', () => {
  it('does not turn unreported cost into zero even with complete tokens', () => {
    const usage = new EvaluationUsage();
    usage.add({ inputTokens: 10, outputTokens: 5, costUsd: 0.1 });
    usage.add({ inputTokens: 20, outputTokens: 10 });
    expect(usage.value()).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      knownCostUsd: 0.1,
      unknown: false,
      costUnknown: true,
    });
  });
  it('known cost does not imply complete tokens and missing usage remains unknown', () => {
    const usage = new EvaluationUsage();
    usage.add({ costUsd: 0.2 });
    expect(usage.value()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      knownCostUsd: 0.2,
      costUsd: 0.2,
      unknown: true,
      costUnknown: false,
    });
    usage.add();
    expect(usage.value().costUsd).toBeUndefined();
    expect(usage.value().costUnknown).toBe(true);
  });
});
