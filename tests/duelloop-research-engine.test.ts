import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuelLoop, FixtureDecisionModel, SqliteStore, type ResearchProvider } from 'duelloop';
import { createPokerDomain, POKER_DOMAIN_ID } from '../src/poker/domain.js';
import { createPokerStrategy } from '../src/poker/strategy.js';
import { createPokerEvaluator } from '../src/evaluation/poker/adapter.js';
import { createPokerPilotProtocols } from '../src/evaluation/poker/protocol.js';
import {
  parseDuelLoopResearchConfig,
  type DuelLoopResearchConfig,
} from '../src/duelloop/research/config.js';
import { createResearchEngine } from '../src/duelloop/research/engine.js';
import { createReleaseControls } from '../src/duelloop/research/releases.js';

const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup(
  provider?: ResearchProvider,
  activationMode: DuelLoopResearchConfig['activationMode'] = 'automatic_after_validation',
  activationPaused = false,
) {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  const domain = createPokerDomain({
    observe: async () => {
      throw new Error('no live');
    },
    candidates: async () => [],
  });
  const model = new FixtureDecisionModel('research-fixture', () => ({
    score: 0,
    confidence: 1,
    probabilities: { '0': 1 },
  }));
  const config = {
    ...parseDuelLoopResearchConfig({}),
    settledTrajectories: 1,
    cooldownMs: 0,
    activationMode,
  };
  const runtime = new DuelLoop({
    applicationId: 'test',
    domain,
    model,
    store,
    mode: 'shadow',
    executionOwner: 'host',
    ...config.decisionPolicy,
  });
  runtime.bootstrap(createPokerStrategy(), 'scope');
  const protocols = createPokerPilotProtocols(POKER_DOMAIN_ID, 1000);
  const run = vi.fn<ResearchProvider['run']>().mockResolvedValue({
    output: { status: 'no_change', reason: 'No evidence supports a change' },
    usage: { inputTokens: 1, outputTokens: 1, unknown: false, costUnknown: true },
  });
  const releaseSession = vi.fn().mockResolvedValue(undefined);
  store.setActivationMode('scope', 'explicit');
  store.pauseActivation('scope', activationPaused);
  const engine = createResearchEngine({
    store,
    scopeId: 'scope',
    domain,
    model,
    config,
    evaluator: createPokerEvaluator({ domain, decisionPolicy: config.decisionPolicy }),
    dependencies: runtime.dependencies,
    protocol: protocols.final,
    developmentProtocol: protocols.development,
    provider: provider ?? { id: 'fixture-research', kind: 'fixture', run, releaseSession },
  });
  const feedback = (id: string, revision = 1) =>
    store.recordFeedback({
      feedbackId: id,
      revision,
      receivedAt: Date.now(),
      eventTime: Date.now(),
      applicationId: 'test',
      strategyScopeId: 'scope',
      trajectoryId: `hand:${id}`,
      settled: true,
      metrics: { net_chips: 1 },
    });
  return { engine, store, runtime, protocols, run, releaseSession, feedback };
}
describe('SDK research application assembly', () => {
  it('uses persistent first-settlement triggers and never republishes legacy advice', async () => {
    const { engine, store, run, releaseSession, feedback } = setup();
    expect(engine.status().activation.activationMode).toBe('automatic_after_validation');
    expect(await engine.worker.tick()).toBeNull();
    feedback('one');
    expect((await engine.worker.tick())?.run.status).toBe('no_change');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].prompt).not.toContain('9901');
    expect(run.mock.calls[0]![0].prompt).not.toContain('poker-pilot-final-v1');
    expect(releaseSession).toHaveBeenCalledTimes(1);
    feedback('one', 2);
    expect(await engine.worker.tick()).toBeNull();
    feedback('two');
    expect((await engine.worker.tick())?.run.status).toBe('no_change');
    expect(run).toHaveBeenCalledTimes(2);
    expect(store.listRuns('scope')).toHaveLength(2);
    expect(engine.status().pendingReleases).toEqual([]);
    await engine.close();
  });
  it.each(['explicit', 'candidate_only', 'automatic_after_validation'] as const)(
    'uses configured %s activation without changing activation pause',
    async (activationMode) => {
      const { engine } = setup(undefined, activationMode, true);
      expect(engine.status().activation.activationMode).toBe(activationMode);
      expect(engine.status().activation.activationPaused).toBe(true);
      await engine.close();
    },
  );
  it('recovers interrupted paid work without replaying provider calls', async () => {
    const { engine, store, run, protocols } = setup();
    const task = engine.orchestrator.create({
      scopeId: 'scope',
      protocol: protocols.final,
      developmentProtocol: protocols.development,
    });
    store.transitionRun(task.id, ['created'], 'researching');
    const recovered = await engine.recover();
    expect(recovered?.status).toBe('error');
    expect(run).not.toHaveBeenCalled();
    expect(
      store.events({ scopeId: 'scope', types: ['research.recovery_unknown_usage'] }),
    ).toHaveLength(1);
    await engine.close();
  });
  it('starts a durable created run exactly once on recovery', async () => {
    const { engine, run, protocols } = setup();
    engine.orchestrator.create({
      scopeId: 'scope',
      protocol: protocols.final,
      developmentProtocol: protocols.development,
    });
    expect((await engine.recover())?.status).toBe('no_change');
    expect(await engine.recover()).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    await engine.close();
  });
  it('cancels a scoped run durably without executing a provider', async () => {
    const { engine, run, protocols, store } = setup();
    const task = engine.orchestrator.create({
      scopeId: 'scope',
      protocol: protocols.final,
      developmentProtocol: protocols.development,
    });
    expect(engine.cancel(task.id).status).toBe('cancelled');
    expect(store.getRun(task.id).status).toBe('cancelled');
    expect(run).not.toHaveBeenCalled();
    await engine.close();
  });
  it('does not approve an unvalidated bootstrap as a research result and preserves explicit control', async () => {
    const { runtime, store, engine } = setup(undefined, 'explicit');
    const controls = createReleaseControls(runtime, store, 'scope');
    await expect(controls.approve(store.activeRelease('scope')!)).rejects.toMatchObject({
      code: 'VALIDATION_REJECTED',
    });
    controls.pause(true);
    expect(controls.status().activationPaused).toBe(true);
    controls.pause(false);
    expect(controls.status().activationMode).toBe('explicit');
    await engine.close();
  });
});
