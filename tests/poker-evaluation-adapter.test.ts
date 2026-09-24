import { describe, expect, it, vi } from 'vitest';
import {
  FixtureDecisionModel,
  behaviorDependencies,
  evaluateCandidate,
  type DecisionModel,
  type EvaluationProtocol,
  type Features,
  type ScoreQuestion,
} from 'duelloop';
import { createPokerDomain, POKER_DOMAIN_ID } from '../src/poker/domain.js';
import { createPokerStrategy } from '../src/poker/strategy.js';
import { createPokerEvaluator } from '../src/evaluation/poker/adapter.js';
import { createPokerPilotProtocols } from '../src/evaluation/poker/protocol.js';

const domain = createPokerDomain({
  async observe() {
    throw new Error('No live observation');
  },
  async candidates() {
    throw new Error('No live candidates');
  },
});
const policy = { maxDecisionMs: 1000, executionReserveMs: 10, randomSeed: 'fixture-sample-v1' };
function model(onRequest?: (state: Features, questions: ScoreQuestion[]) => void): DecisionModel {
  const fixture = new FixtureDecisionModel('rules-only', (q) => {
    const aggressive = q.instructions.includes('TEST_ONLY_ALL_IN');
    const preferred = aggressive
      ? q.actionId === 'all_in'
      : q.actionId === 'check' || q.actionId === 'fold';
    const max = q.criteria.length - 1;
    return {
      score: preferred ? max : 0,
      confidence: 1,
      probabilities: Object.fromEntries(
        q.criteria.map((_, i) => [String(i), Number(i === (preferred ? max : 0))]),
      ),
    };
  });
  return {
    ...fixture,
    id: fixture.id,
    kind: fixture.kind,
    behaviorIdentity: fixture.behaviorIdentity,
    async score(request) {
      onRequest?.(request.state, request.questions);
      return fixture.score(request);
    },
  };
}
function input(model_: DecisionModel) {
  return {
    strategy: createPokerStrategy(),
    model: model_,
    seed: 3,
    opponentId: 'mixed-v1',
    trajectories: 6,
    knowledge: {},
    knowledgeStateMode: 'frozen' as const,
    signal: new AbortController().signal,
  };
}

describe('independent SDK poker EvaluationAdapter', () => {
  it('carries only previously applied choices through streets and resets independent branch histories', async () => {
    type Choice = {
      street: string;
      action: { kind: string; raiseToChips?: number };
      source: string;
      status: string;
    };
    type Poker = { street: string; session: { turn: number; previousChoices: Choice[] } };
    const branches: { sessions: Poker[]; hands: number; choices: Choice[] }[] = [];
    function sessionModel(preferRaise: boolean): DecisionModel {
      const branch = { sessions: [] as Poker[], hands: 0, choices: [] as Choice[] };
      branches.push(branch);
      return {
        id: `session-${preferRaise}`,
        kind: 'fixture',
        behaviorIdentity: {
          adapterVersion: 'session-fixture-v1',
          deploymentVersion: 'test',
          protocolVersion: 'score',
          configurationDigest: String(preferRaise),
        },
        async score(request) {
          const poker = (request.state.features as { poker: Poker }).poker;
          expect(poker.session).not.toBeNull();
          if (poker.session.turn === 1) {
            branch.hands++;
            branch.choices = [];
          }
          expect(poker.session.turn).toBe(branch.choices.length + 1);
          expect(poker.session.previousChoices).toEqual(branch.choices.slice(-6));
          branch.sessions.push(structuredClone(poker));
          const preferred =
            preferRaise && poker.session.turn === 1
              ? request.questions.find((q) => q.actionId.startsWith('raise_'))?.actionId
              : undefined;
          const id =
            preferred ??
            ['check', 'call', 'fold'].find((action) =>
              request.questions.some((q) => q.actionId === action),
            )!;
          branch.choices.push({
            street: poker.street,
            action: id.startsWith('raise_')
              ? { kind: 'raise', raiseToChips: Number(id.slice('raise_to_'.length)) }
              : { kind: id },
            status: 'accepted',
            source: 'jev',
          });
          return {
            model: this.id,
            usage: { inputTokens: 1, outputTokens: 1 },
            answers: Object.fromEntries(
              request.questions.map((q) => {
                const score = q.actionId === id ? q.criteria.length - 1 : 0;
                return [
                  q.id,
                  {
                    score,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      q.criteria.map((_, i) => [String(i), Number(i === score)]),
                    ),
                  },
                ];
              }),
            ),
          };
        },
      };
    }
    const adapter = createPokerEvaluator({ domain, decisionPolicy: policy });
    // Shared adapter instance, concurrent episodes, and identical hand IDs must not share memory.
    await Promise.all([
      adapter.episode(input(sessionModel(false))),
      adapter.episode(input(sessionModel(true))),
    ]);
    // A hand can end before hero acts (a walk); every observed hand still starts independently.
    for (const branch of branches) {
      expect(branch.hands).toBeGreaterThan(1);
      expect(branch.hands).toBeLessThanOrEqual(6);
    }
    expect(new Set(branches[0]!.sessions.map((poker) => poker.street))).toEqual(
      new Set(['preflop', 'flop', 'turn', 'river']),
    );
    expect(
      branches[0]!.sessions.some(
        (poker) => poker.session.previousChoices.at(-1)?.street === poker.street,
      ),
    ).toBe(true);
    expect(
      branches[1]!.sessions.some((poker) =>
        poker.session.previousChoices.some((choice) => choice.action.kind === 'raise'),
      ),
    ).toBe(true);
    expect(
      branches[0]!.sessions.every((poker) =>
        poker.session.previousChoices.every((choice) => choice.action.kind !== 'raise'),
      ),
    ).toBe(true);
  });
  it('calls a supplied model for every hero decision and sends only shared visible features', async () => {
    const seen = vi.fn((state: Features, questions: ScoreQuestion[]) => {
      const features = state.features as {
        poker: { holeCards: string[]; board: string[]; seats: Record<string, unknown>[] };
        facts: unknown;
      };
      expect(Object.keys(features).sort()).toEqual(['facts', 'poker']);
      expect(features.poker.holeCards).toHaveLength(2);
      expect([0, 3, 4, 5]).toContain(features.poker.board.length);
      expect(features.poker.seats.every((seat) => !('cards' in seat))).toBe(true);
      expect(JSON.stringify(state)).not.toContain('deck');
      expect(questions.length).toBeGreaterThan(0);
    });
    const result = await createPokerEvaluator({ domain, decisionPolicy: policy }).episode(
      input(model(seen)),
    );
    expect(result.decisions).toBeGreaterThan(0);
    expect(result.modelCalls).toBe(seen.mock.calls.length);
    expect(result.modelCalls).toBe(result.decisions);
    expect(result.decisionComputeLatenciesMs).toHaveLength(result.decisions);
    expect(Number.isFinite(result.reward)).toBe(true);
  });
  it('executes candidate and baseline as separate branches and reports seed blocks, not decisions', async () => {
    const baseline = createPokerStrategy();
    const candidate = structuredClone(baseline);
    candidate.version = 'fixture-aggressive';
    candidate.questions[0]!.instructions += ' TEST_ONLY_ALL_IN';
    const adapter = createPokerEvaluator({ domain, decisionPolicy: policy });
    const decisionModel = model();
    const protocol: EvaluationProtocol = {
      ...createPokerPilotProtocols(POKER_DOMAIN_ID, 1000).development,
      seeds: [3, 4],
      trajectoriesPerSeed: 2,
      opponentIds: ['mixed-v1'],
    };
    let blocks: { baseline: { reward: number }; candidate: { reward: number } }[] = [];
    const report = await evaluateCandidate({
      candidate,
      baseline,
      adapter,
      model: decisionModel,
      dependencies: behaviorDependencies(domain, decisionModel, policy),
      baseReleaseDigest: 'fixture-baseline',
      protocol,
      stage: 'development',
      onEvidence: (e) => {
        blocks = e.blocks;
      },
    });
    expect(report.modelKind).toBe('fixture');
    expect(report.sampleCount).toBe(2);
    expect(report.reasons).toContain('insufficient_independent_samples');
    expect(report.status).not.toBe('passed');
    expect(blocks.some((block) => block.baseline.reward !== block.candidate.reward)).toBe(true);
  });
  it('reproduces settled rewards and visible action inputs for the same seed, with fresh branches', async () => {
    const first: string[] = [];
    const second: string[] = [];
    const adapter = createPokerEvaluator({ domain, decisionPolicy: policy });
    const a = await adapter.episode(input(model((state) => first.push(JSON.stringify(state)))));
    const b = await adapter.episode(input(model((state) => second.push(JSON.stringify(state)))));
    expect(a.reward).toBe(b.reward);
    expect(a.decisions).toBe(b.decisions);
    expect(first).toEqual(second);
  });
  it('propagates model failure rather than silently playing an action', async () => {
    const broken = model();
    broken.score = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    await expect(
      createPokerEvaluator({ domain, decisionPolicy: policy }).episode(input(broken)),
    ).rejects.toThrow('provider unavailable');
    expect(broken.score).toHaveBeenCalledTimes(1);
  });
  it('aborts uncooperative in-flight model work without executing a late result', async () => {
    const stuck = model();
    const realScore = stuck.score;
    let calls = 0;
    stuck.score = async (request) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return realScore(request);
    };
    const result = createPokerEvaluator({
      domain,
      decisionPolicy: { maxDecisionMs: 20, executionReserveMs: 5 },
    }).episode(input(stuck));
    await expect(result).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(calls).toBe(1);
  });
  it('rejects unsupported mutable knowledge, mismatched synthetic identities and nondeterministic softmax', async () => {
    const adapter = createPokerEvaluator({ domain, decisionPolicy: policy });
    await expect(
      adapter.episode({ ...input(model()), knowledgeStateMode: 'online_update' }),
    ).rejects.toThrow('unsupported');
    await expect(
      adapter.episode({ ...input(model()), knowledge: { opponentMemory: [{}] } }),
    ).rejects.toThrow('not transferable');
    const softmax = input(model());
    softmax.strategy.decision.selection = {
      mode: 'softmax_sample',
      tieBreak: 'domain_priority',
      temperature: 1,
    };
    await expect(
      createPokerEvaluator({
        domain,
        decisionPolicy: { maxDecisionMs: 1000, executionReserveMs: 10 },
      }).episode(softmax),
    ).rejects.toThrow('release-bound random seed');
  });
  it('rejects dependency mismatch in SDK evaluation before any model calls', async () => {
    const decisionModel = model();
    const score = vi.spyOn(decisionModel, 'score');
    const strategy = createPokerStrategy();
    const adapter = createPokerEvaluator({ domain, decisionPolicy: policy });
    const dependencies = behaviorDependencies(domain, decisionModel, {
      ...policy,
      maxDecisionMs: 2000,
    });
    await expect(
      evaluateCandidate({
        candidate: strategy,
        baseline: strategy,
        adapter,
        model: decisionModel,
        dependencies,
        baseReleaseDigest: 'fixture-baseline',
        protocol: createPokerPilotProtocols(POKER_DOMAIN_ID, 1000).development,
        stage: 'development',
      }),
    ).rejects.toThrow('runtime binding');
    expect(score).not.toHaveBeenCalled();
  });
  it('rejects reports using the pre-session behavior identity before any model calls', async () => {
    const decisionModel = model();
    const score = vi.spyOn(decisionModel, 'score');
    const dependencies = behaviorDependencies(
      {
        ...domain,
        featureBuilderVersion: 'visible-facts-priced-actions-v3',
        continuationVersion: 'same-release-current-visible-state-v1',
      },
      decisionModel,
      policy,
    );
    const adapter = createPokerEvaluator({ domain, decisionPolicy: policy });
    expect(adapter.id).toMatch(/^poker-six-max-session-v2:/);
    expect(domain.rulesVersion).toBe('six-max-nlhe-v3');
    await expect(
      evaluateCandidate({
        candidate: createPokerStrategy(),
        baseline: createPokerStrategy(),
        adapter,
        model: decisionModel,
        dependencies,
        baseReleaseDigest: 'old-contract',
        protocol: createPokerPilotProtocols(POKER_DOMAIN_ID, 1000).development,
        stage: 'development',
      }),
    ).rejects.toThrow();
    expect(score).not.toHaveBeenCalled();
  });
});
