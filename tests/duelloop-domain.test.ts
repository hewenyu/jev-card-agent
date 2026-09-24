import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DuelLoop,
  FixtureDecisionModel,
  SqliteStore,
  digest,
  type DecisionRecord,
  type ScoreAnswer,
} from 'duelloop';
import {
  createPokerReplayDomain,
  POKER_REPLAY_APPLICATION_ID,
  POKER_REPLAY_SCOPE_ID,
  replayInput,
} from '../src/duelloop/domain.js';
import { createPokerReplayStrategy } from '../src/duelloop/strategy.js';
import type { ReplaySample } from '../src/duelloop/plan.js';

function sample(): ReplaySample {
  const request = {
    model: 'jev-1.13.0',
    state: {
      street: 'river',
      board: ['2c', '7d', 'Js', 'Qh', 'Ac'],
      holeCards: ['Kh', 'Td'],
      heroSeat: 1,
      dealerSeat: 3,
      bigBlind: 20,
      historyIncomplete: false,
      opponentMemory: [{ name: 'opponent', observedHands: 12 }],
    },
    questions: {
      action: {
        type: 'choice' as const,
        instructions: { task: 'Choose best long-run chip expectation; never invent hidden cards.' },
        criteria: {
          check: { action: 'check', additionalChips: 0 },
          raise_120: {
            action: 'raise',
            additionalChips: 100,
            raiseToChips: 120,
            stackFraction: 0.2,
          },
        },
      },
    },
  };
  return {
    decisionId: 'decision-river',
    runId: 'recorded-run',
    handId: 'recorded-hand',
    tableId: 'recorded-table',
    street: 'river',
    originalAt: '2026-09-01T00:00:00.000Z',
    originalChoice: 'check',
    originalModel: request.model,
    originalLatencyMs: 320,
    inputHash: digest(request),
    request,
    candidates: [
      { id: 'check', action: 'check', label: 'Check' },
      { id: 'raise_120', action: 'raise', amount: 120, label: 'Raise to 120' },
    ],
  };
}

function grade(level: number): ScoreAnswer {
  return {
    score: level,
    confidence: 1,
    probabilities: Object.fromEntries(
      Array.from({ length: 5 }, (_, n) => [String(n), n === level ? 1 : 0]),
    ),
  };
}

const instances: { loop: DuelLoop; store: SqliteStore }[] = [];
function runtime(answer = (actionId: string) => grade(actionId === 'raise_120' ? 4 : 1)) {
  const domain = createPokerReplayDomain();
  const model = new FixtureDecisionModel('poker-replay-fixture', (question) =>
    answer(question.actionId),
  );
  const score = vi.spyOn(model, 'score');
  const store = new SqliteStore();
  const loop = new DuelLoop({
    applicationId: POKER_REPLAY_APPLICATION_ID,
    domain,
    model,
    store,
    mode: 'shadow',
    executionOwner: 'host',
    maxDecisionMs: 1000,
    executionReserveMs: 0,
  });
  instances.push({ loop, store });
  const release = loop.bootstrap(createPokerReplayStrategy(), POKER_REPLAY_SCOPE_ID);
  return { domain, model, score, store, loop, release };
}

afterEach(async () => {
  for (const { loop, store } of instances.splice(0)) {
    await loop.close();
    store.close();
  }
  vi.restoreAllMocks();
});

describe('DuelLoop archived poker domain', () => {
  it('preserves priced candidate semantics and archived inputs without source choices or future outcomes', async () => {
    const archived = Object.assign(sample(), {
      historicalOutcome: { netChips: 999, showdown: ['Ah', 'Ad'] },
      privateFuture: 'future-result-must-stay-out',
    });
    const before = structuredClone(archived);
    const { observation, candidates } = replayInput(archived, 1000);
    const { loop, score, store } = runtime();
    const decision = await loop.decide(observation, candidates);
    expect(decision.action?.id).toBe('raise_120');
    expect(decision.modelKind).toBe('fixture');
    expect(decision.utilities).toEqual({ check: 0.25, raise_120: 1 });
    expect(candidates[1]?.parameters).toEqual(archived.request.questions.action.criteria.raise_120);
    expect(candidates[1]?.parameters).not.toBe(
      archived.request.questions.action.criteria.raise_120,
    );
    expect(observation.features).toEqual({
      poker: archived.request.state,
      pokerInstructions: { archived: archived.request.questions.action.instructions },
    });
    const wireState = score.mock.calls[0]![0].state;
    expect(JSON.stringify(wireState)).not.toContain('future-result-must-stay-out');
    expect(JSON.stringify(wireState)).not.toContain('originalChoice');
    expect(JSON.stringify(wireState)).not.toContain('historicalOutcome');
    expect(observation.observedAt).toBeGreaterThan(Date.parse(archived.originalAt));
    expect(observation.deadline - observation.observedAt).toBe(1000);
    expect(archived).toEqual(before);
    expect(store.listArtifacts('decision')).toHaveLength(1);
    expect(store.intents()).toEqual([]);
  });

  it('requires a model result even for a single legal candidate', async () => {
    const archived = sample();
    archived.candidates = [archived.candidates[0]!];
    archived.request.questions.action.criteria = { check: { action: 'check', additionalChips: 0 } };
    archived.inputHash = digest(archived.request);
    const { observation, candidates } = replayInput(archived, 1000);
    const { loop, score } = runtime();
    const decision = await loop.decide(observation, candidates);
    expect(score).toHaveBeenCalledTimes(1);
    expect(decision.questions).toHaveLength(1);
    expect(decision.action?.id).toBe('check');
  });

  it('cannot observe current tables, execute actions or evaluate counterfactual profit', async () => {
    const { domain, loop, store } = runtime();
    expect(domain.capabilities.execution).toBe(false);
    expect(domain.capabilities.evaluation).toBe(false);
    expect(domain.execute).toBeUndefined();
    await expect(domain.observe('any-live-table')).rejects.toThrow('frozen observation');
    const { observation, candidates } = replayInput(sample(), 1000);
    await expect(domain.candidates(observation)).rejects.toThrow('archived candidates');
    const decision = await loop.decide(observation, candidates);
    await expect(loop.prepareHostExecution(decision)).rejects.toThrow('Host execution is disabled');
    await expect(loop.executeDecision(decision)).rejects.toThrow('does not own execution');
    expect(store.intents()).toEqual([]);
  });

  it('keeps original-hand release bindings and rejects an unvalidated bootstrap replacement', async () => {
    const { loop, store, release } = runtime();
    const first = replayInput(sample(), 1000);
    expect((await loop.decide(first.observation, first.candidates)).releaseDigest).toBe(release);
    const updated = createPokerReplayStrategy();
    updated.version = 'test-v2';
    const nextRelease = store.registerRelease({
      strategyDigest: store.putArtifact('strategy', updated),
      dependencies: loop.dependencies,
      scopeId: POKER_REPLAY_SCOPE_ID,
      expectedActiveDigest: release,
      validationDigest: null,
      source: 'bootstrap',
    });
    await expect(loop.activate(nextRelease, true)).rejects.toThrow(
      'Bootstrap only allowed for empty scope',
    );
    const sameHand = sample();
    sameHand.request.state.pokerTestRevision = 2;
    sameHand.inputHash = digest(sameHand.request);
    const second = replayInput(sameHand, 1000);
    expect(second.observation.trajectoryId).toBe(first.observation.trajectoryId);
    expect(second.observation.revision).not.toBe(first.observation.revision);
    expect((await loop.decide(second.observation, second.candidates)).releaseDigest).toBe(release);
    sameHand.handId = 'next-recorded-hand';
    const nextHand = replayInput(sameHand, 1000);
    expect(nextHand.observation.trajectoryId).not.toBe(first.observation.trajectoryId);
    expect((await loop.decide(nextHand.observation, nextHand.candidates)).releaseDigest).toBe(
      release,
    );
  });

  it('uses archived candidate order for ties and persists the resulting selection probabilities', async () => {
    const { loop } = runtime(() => grade(2));
    const input = replayInput(sample(), 1000);
    const result = await loop.decide(input.observation, input.candidates);
    expect(result.action?.id).toBe('check');
    expect(result.utilities).toEqual({ check: 0.5, raise_120: 0.5 });
    expect(result.probabilities).toEqual({ check: 1, raise_120: 0 });
  });

  it('rejects expired replay deadlines before calling the model', async () => {
    const { loop, score } = runtime();
    const input = replayInput(sample(), 1000);
    input.observation.deadline = Date.now() - 1;
    await expect(loop.decide(input.observation, input.candidates)).rejects.toThrow(
      'deadline expired',
    );
    expect(score).not.toHaveBeenCalled();
  });

  it('records unsuccessful model decisions without fabricating an action', async () => {
    const { loop, store } = runtime(() => ({ ...grade(4), score: 5 }));
    const input = replayInput(sample(), 1000);
    await expect(loop.decide(input.observation, input.candidates)).rejects.toThrow('Invalid Score');
    const records = store
      .listArtifacts('decision')
      .map((artifact) => artifact.value as unknown as DecisionRecord);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: null,
      decisionSource: 'stopped',
      stopReason: 'MODEL_INVALID',
    });
    expect(records[0]?.utilities).toEqual({});
    expect(store.intents()).toEqual([]);
  });

  it('rejects altered archive inputs and mismatched candidate descriptions', () => {
    const archived = sample();
    archived.request.state.street = 'turn';
    expect(() => replayInput(archived, 1000)).toThrow('digest mismatch');
    archived.inputHash = digest(archived.request);
    archived.candidates[1]!.action = 'call';
    expect(() => replayInput(archived, 1000)).toThrow('action mismatch');
    expect(() => replayInput(sample(), 0)).toThrow('positive integer');
  });
});
