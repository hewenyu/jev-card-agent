import {
  DuelLoop,
  FixtureDecisionModel,
  SqliteStore,
  type CandidateAction,
  type Observation,
} from 'duelloop';
import { buildCandidates, createInitialState, type PokerState } from '../../src/core/index.js';
import { Store } from '../../src/storage/store.js';
import { decisionStateKey } from '../../src/runtime/authority.js';
import type { StoredAction } from '../../src/runtime/types.js';
import { baselineSnapshot } from '../../src/knowledge/store.js';
import type { KnowledgeSnapshot } from '../../src/knowledge/types.js';
import { HostJournal } from '../../src/duelloop/host/journal.js';
import { HostBridge } from '../../src/duelloop/host/bridge.js';
import { HandBindings } from '../../src/duelloop/live/bindings.js';
import { createPokerDomain } from '../../src/poker/domain.js';
import { createPokerStrategy } from '../../src/poker/strategy.js';

export function pokerState(): PokerState {
  return {
    ...createInitialState(),
    tableId: 'table',
    handId: 'hand',
    heroSeat: 0,
    actorSeat: 0,
    dealerSeat: 1,
    street: 'flop',
    board: ['Ah', '7d', '2c'],
    holeCards: ['As', 'Kd'],
    pot: 60,
    smallBlind: 10,
    bigBlind: 20,
    turnToken: 'turn-token',
    lastTableSeq: 10,
    validActions: [{ action: 'check' }, { action: 'fold' }, { action: 'raise', min: 20, max: 200 }],
    seats: [
      { seat: 0, name: 'hero', stack: 500, bet: 0, status: 'active', inHand: true },
      { seat: 1, name: 'other', stack: 500, bet: 0, status: 'active', inHand: true },
    ],
  };
}

export function hostFixture(
  options: { rawPath?: string; sdkPath?: string; facts?: (at: string) => KnowledgeSnapshot } = {},
) {
  const raw = new Store(options.rawPath ?? ':memory:');
  if (!raw.db.prepare('SELECT 1 FROM runs WHERE id=?').get('fixture-run'))
    raw.beginRun({
      id: 'fixture-run',
      kind: 'demo',
      strategy: 'jev',
      startedAt: new Date().toISOString(),
      config: {},
    });
  raw.acquireLease();
  const journal = new HostJournal(raw.db),
    sdk = new SqliteStore(options.sdkPath ?? ':memory:');
  const state = pokerState();
  const authorityDeadline = Date.now() + 60_000;
  const input = (): { observation: Observation; candidates: CandidateAction[] } => ({
    observation: {
      applicationId: 'jev-card-agent',
      domainId: 'openpoker-six-max',
      strategyScopeId: 'fixture-scope',
      streamId: JSON.stringify(['hero-id', state.tableId]),
      actorId: 'hero-id',
      trajectoryId: JSON.stringify([state.tableId, state.handId]),
      revision: decisionStateKey(state),
      observedAt: Date.now(),
      deadline: authorityDeadline,
      features: { poker: {}, facts: {} },
    },
    candidates: buildCandidates(state).map((candidate) => ({
      id: candidate.id,
      kind: candidate.action,
      revision: decisionStateKey(state),
      parameters: {
        action: candidate.action,
        ...(candidate.amount === undefined ? {} : { raiseToChips: candidate.amount }),
      },
    })),
  });
  const domain = createPokerDomain({
    observe: async () => input().observation,
    candidates: async () => input().candidates,
  });
  let modelCalls = 0;
  const model = new FixtureDecisionModel('host-fixture', (question) => {
    modelCalls++;
    const score = question.actionId === 'check' ? question.criteria.length - 1 : 0;
    return {
      score,
      confidence: 1,
      probabilities: Object.fromEntries(
        question.criteria.map((_, index) => [index, index === score ? 1 : 0]),
      ),
    };
  });
  const runtime = new DuelLoop({
    applicationId: 'jev-card-agent',
    domain,
    model,
    store: sdk,
    mode: 'simulation',
    executionOwner: 'host',
  });
  if (!sdk.activeRelease('fixture-scope'))
    runtime.bootstrap(createPokerStrategy(), 'fixture-scope');
  const bindings = new HandBindings(
    journal,
    runtime,
    'fixture-scope',
    'hero-id',
    options.facts ?? baselineSnapshot,
  );
  const bridge = new HostBridge(raw, journal, sdk, runtime, bindings);
  const decide = async () => {
    const value = input();
    const record = await runtime.decide(value.observation, value.candidates);
    const action: StoredAction = {
      id: record.decisionId,
      decisionId: record.decisionId,
      runId: 'fixture-run',
      tableId: state.tableId!,
      createdAt: new Date().toISOString(),
      status: 'prepared',
      deadlineAt: value.observation.deadline,
      stateKey: decisionStateKey(state, false),
      payload: {
        type: 'action',
        action: record.action!.kind,
        client_action_id: record.decisionId,
        hand_id: state.handId!,
        turn_token: state.turnToken!,
        ...(record.action!.kind === 'raise'
          ? { amount: Number(record.action!.parameters.raiseToChips) }
          : {}),
      },
    };
    return { record, action };
  };
  const ready = async () => {
    const result = await decide();
    journal.decision(result.record, 'fixture-run');
    await runtime.prepareHostExecution(result.record);
    bridge.prepare(result.action);
    return result;
  };
  const close = async () => {
    await runtime.close();
    sdk.close();
    raw.close();
  };
  return {
    raw,
    journal,
    sdk,
    runtime,
    state,
    input,
    bindings,
    bridge,
    decide,
    ready,
    close,
    modelCalls: () => modelCalls,
  };
}

export async function activateNext(fixture: ReturnType<typeof hostFixture>) {
  const { sdk, runtime } = fixture;
  const first = sdk.activeRelease('fixture-scope')!;
  const strategy = createPokerStrategy();
  strategy.version = 'verified-next';
  const strategyDigest = sdk.putArtifact('strategy', strategy);
  const run = sdk.createRun({
    id: 'verified-next',
    scopeId: 'fixture-scope',
    baseReleaseDigest: first,
    researchSnapshotId: sdk.snapshot('fixture-scope', Date.now()),
    evaluationProtocolDigest: sdk.putArtifact('protocol', { id: 'fixture-protocol' }, 'private'),
    status: 'created',
    data: {},
  });
  sdk.transitionRun(run.id, ['created'], 'researching');
  sdk.transitionRun(run.id, ['researching'], 'candidate_locked');
  sdk.transitionRun(run.id, ['candidate_locked'], 'final_evaluating');
  sdk.transitionRun(run.id, ['final_evaluating'], 'completed_passed');
  const validationDigest = sdk.putArtifact(
    'validation_report',
    {
      candidateDigest: strategyDigest,
      baseReleaseDigest: first,
      dependencies: runtime.dependencies,
      status: 'passed',
      stage: 'final',
      modelKind: 'fixture',
    },
    'private',
  );
  const next = sdk.registerRelease({
    strategyDigest,
    dependencies: runtime.dependencies,
    scopeId: 'fixture-scope',
    expectedActiveDigest: first,
    validationDigest,
    source: 'research',
    researchRunId: run.id,
  });
  await runtime.activate(next, true);
  return next;
}
