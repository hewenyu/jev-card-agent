import { describe, expect, it } from 'vitest';
import {
  FixtureDecisionModel,
  behaviorDependencies,
  type BehaviorCase,
  type CandidateSubmission,
  type EvaluationAdapter,
  type ResearchProvider,
  type StrategyPackage,
} from 'duelloop';
import { Store } from '../src/storage/store.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { createPokerDomain, POKER_DOMAIN_ID } from '../src/poker/domain.js';
import { createPokerEvaluator } from '../src/evaluation/poker/adapter.js';
import { createPokerPilotProtocols } from '../src/evaluation/poker/protocol.js';
import { LiveDecisionCoordinator } from '../src/duelloop/live/coordinator.js';
import { createLiveModel } from '../src/duelloop/live/model.js';
import { createResearchEngine } from '../src/duelloop/research/engine.js';
import { createReleaseControls } from '../src/duelloop/research/releases.js';
import { parseDuelLoopResearchConfig } from '../src/duelloop/research/config.js';
import { pokerState } from './helpers/duelloop-fixture.js';

describe('synthetic application research-to-live release lifecycle', () => {
  it('validates a candidate, explicitly approves it for later hands and rolls back without changing existing pins', async () => {
    const raw = new Store(':memory:');
    const state = pokerState();
    const config = parseDuelLoopResearchConfig({});
    const model = new FixtureDecisionModel(
      'synthetic-lifecycle-no-poker-performance-claim',
      () => ({
        score: 0,
        confidence: 1,
        probabilities: { '0': 1 },
      }),
    );
    const coordinator = new LiveDecisionCoordinator({
      raw,
      databasePath: ':memory:',
      scopeId: 'lifecycle-scope',
      actorId: 'hero',
      state: () => state,
      facts: baselineSnapshot,
      model,
      mode: 'simulation',
      decisionPolicy: config.decisionPolicy,
    });
    const store = coordinator.sdk;
    const domain = createPokerDomain({
      observe: async () => {
        throw new Error('research has no arena observation');
      },
      candidates: async () => {
        throw new Error('research has no arena authority');
      },
      evaluation: true,
    });
    const dependencies = behaviorDependencies(domain, model, config.decisionPolicy);
    expect(dependencies).toEqual(coordinator.runtime.dependencies);
    // Both production assemblies use the same factory, despite different private credentials.
    const factoryModel = (apiKey: string) =>
      createLiveModel({ ...config.jev, apiKey }, { onAttempt() {} });
    expect(
      behaviorDependencies(domain, factoryModel('live-secret'), config.decisionPolicy),
    ).toEqual(behaviorDependencies(domain, factoryModel('research-secret'), config.decisionPolicy));
    const adapter = createPokerEvaluator({ domain, decisionPolicy: config.decisionPolicy });
    const evaluated: string[] = [];
    // Synthetic rewards test SDK publication wiring only. Real poker rules/branches have separate tests.
    const evaluator: EvaluationAdapter = {
      ...adapter,
      id: 'synthetic-release-lifecycle-no-poker-performance-claim',
      async episode({ strategy }) {
        evaluated.push(strategy.version);
        return {
          reward: strategy.version === 'synthetic-candidate' ? 1 : 0,
          decisions: 1,
          decisionComputeLatenciesMs: [1],
          modelCalls: 0,
        };
      },
    };
    const protocols = createPokerPilotProtocols(POKER_DOMAIN_ID, 1000);
    for (const protocol of Object.values(protocols)) {
      protocol.minSamples = 3;
      protocol.seeds = protocol.seeds.slice(0, 3);
      protocol.opponentIds = ['mixed-v1'];
    }
    const at = new Date().toISOString();
    const original = coordinator.bindings.pin(state, at);
    store.recordFeedback({
      feedbackId: 'synthetic-evidence',
      revision: 1,
      receivedAt: Date.now(),
      eventTime: Date.now(),
      applicationId: 'jev-card-agent',
      strategyScopeId: 'lifecycle-scope',
      trajectoryId: 'completed-fixture',
      settled: true,
      metrics: { net_chips: 0 },
    });
    const provider: ResearchProvider = {
      id: 'synthetic-app-lifecycle',
      kind: 'fixture',
      async run(input) {
        if (input.role === 'integrator') {
          const tool = (name: string) => input.tools.find((item) => item.name === name)!;
          const read = (await tool('read_strategy').execute({})) as unknown as {
            strategy: StrategyPackage;
            submissionContract: {
              bindings: Pick<
                CandidateSubmission,
                | 'researchRunId'
                | 'baseReleaseDigest'
                | 'researchSnapshotId'
                | 'evaluationProtocolDigest'
              >;
              strategyBindings: Partial<StrategyPackage>;
            };
          };
          const candidate = {
            ...read.strategy,
            ...read.submissionContract.strategyBindings,
            version: 'synthetic-candidate',
            provenance: {
              ...read.submissionContract.strategyBindings.provenance!,
              hypothesis: 'Synthetic lifecycle fixture only',
            },
          };
          candidate.decision.defaultWeights.chip_quality = 0.5;
          const observation = {
            applicationId: 'jev-card-agent',
            domainId: POKER_DOMAIN_ID,
            strategyScopeId: 'lifecycle-scope',
            streamId: 'fixture',
            actorId: 'hero',
            trajectoryId: 'completed-fixture',
            revision: '1',
            observedAt: Date.now(),
            deadline: Date.now() + 60000,
            features: { poker: {}, facts: {} },
          };
          const candidates = ['check', 'fold'].map((id) => ({
            id,
            kind: id,
            revision: '1',
            parameters: {},
          }));
          const createCase = async (id: string, regression: boolean) => {
            const answers = Object.fromEntries(
              candidates.map((action) => {
                const max = candidate.questions[0]!.criteria.length - 1;
                const score = !regression && action.id === 'check' ? max : 0;
                return [
                  `chip_quality:${action.id}`,
                  {
                    score,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      candidate.questions[0]!.criteria.map((_, n) => [n, Number(n === score)]),
                    ),
                  },
                ];
              }),
            );
            const result = await tool('register_behavior_fixture').execute({
              id,
              strategy: candidate,
              observation,
              candidates,
              answers,
              assertion: regression
                ? { op: 'utilities_equal' }
                : { op: 'utility_margin_decreases', actionId: 'check', otherActionId: 'fold' },
            });
            return (result as unknown as { behaviorCase: BehaviorCase }).behaviorCase;
          };
          const submission: CandidateSubmission = {
            submissionId: 'synthetic-submission',
            ...read.submissionContract.bindings,
            strategy: candidate,
            hypothesis: candidate.provenance.hypothesis,
            evidenceRefs: ['synthetic-evidence@1'],
            expectedBehaviorChanges: [await createCase('expected', false)],
            regressionCases: [await createCase('regression', true)],
            knownRisks: ['Synthetic evaluator; no profitability evidence'],
          };
          await tool('submit_candidate').execute(JSON.parse(JSON.stringify(submission)));
        }
        return {
          output: { analysis: 'Synthetic lifecycle fixture' },
          usage: { inputTokens: 1, outputTokens: 1, unknown: false, costUnknown: true },
        };
      },
    };
    const engine = createResearchEngine({
      store,
      scopeId: 'lifecycle-scope',
      domain,
      model,
      evaluator,
      dependencies,
      config,
      protocol: protocols.final,
      developmentProtocol: protocols.development,
      provider,
    });
    try {
      const run = engine.orchestrator.create({
        scopeId: 'lifecycle-scope',
        protocol: protocols.final,
        developmentProtocol: protocols.development,
      });
      const result = await engine.orchestrator.run(run.id);
      expect(result.run.status, JSON.stringify(result.run)).toBe('completed_passed');
      expect(result.report).toMatchObject({ stage: 'final', modelKind: 'fixture', sampleCount: 3 });
      expect(evaluated.filter((version) => version === 'synthetic-candidate')).toHaveLength(3);
      expect(evaluated.filter((version) => version === 'baseline-v1')).toHaveLength(3);
      expect(store.activeRelease('lifecycle-scope')).toBe(original.releaseDigest);
      expect(store.pendingReleases('lifecycle-scope').map((release) => release.digest)).toContain(
        result.releaseDigest,
      );
      const controls = createReleaseControls(coordinator.runtime, store, 'lifecycle-scope');
      await controls.approve(result.releaseDigest!);
      expect(coordinator.bindings.pin(state, at)).toEqual(original);
      const second = { ...state, handId: 'hand-after-approval' };
      expect(coordinator.bindings.pin(second, at).releaseDigest).toBe(result.releaseDigest);
      await controls.rollback(original.releaseDigest);
      expect(coordinator.bindings.pin(second, at).releaseDigest).toBe(result.releaseDigest);
      expect(
        coordinator.bindings.pin({ ...state, handId: 'hand-after-rollback' }, at).releaseDigest,
      ).toBe(original.releaseDigest);
    } finally {
      await engine.close();
      await coordinator.close();
      raw.close();
    }
  });
});
