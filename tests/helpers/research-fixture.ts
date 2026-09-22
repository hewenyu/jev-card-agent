import { AdviceStore } from '../../src/knowledge/advice-store.js';
import { baselineSnapshot } from '../../src/knowledge/store.js';
import {
  researchBatchHash,
  REQUIRED_REVIEW_SCENARIOS,
} from '../../src/knowledge/advice-validator.js';
import type { ResearchBatchV2, ResearchProposalV2 } from '../../src/research/contracts.js';
import { createInitialState } from '../../src/core/state.js';
import { buildContext } from '../../src/core/context.js';
import { buildCandidates } from '../../src/core/candidates.js';
import type { Store } from '../../src/storage/store.js';

export function researchFixture() {
  const base = baselineSnapshot();
  const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const batch: ResearchBatchV2 = {
    batchId: 'controlled-research-batch',
    taskType: 'leak_review',
    scopeKey: 'global',
    basePolicyVersion: base.version,
    researchPromptVersion: 'controlled-test',
    inputSchemaVersion: 'research-batch-v2',
    rulesetVersion: base.rulesetVersion,
    contextSchemaVersion: base.contextSchemaVersion,
    sourceSnapshotHash: '0'.repeat(64),
    evidenceEventWatermark: 10,
    cutoff: ago(60),
    eligibleHandIds: ['evidence-hand'],
    metrics: [
      {
        id: 'observed',
        name: 'Observed opportunities',
        numerator: 1,
        denominator: 1,
        handIds: ['evidence-hand'],
        throughEventId: 10,
        availableAt: ago(61),
      },
    ],
    examples: [
      {
        id: 'example',
        handId: 'evidence-hand',
        eventId: 10,
        availableAt: ago(61),
        phase: 'decision_visible',
        summary: 'A free check was available.',
      },
    ],
    sampleDefinition: 'One independently recorded controlled scenario.',
    missingness: ['No showdown.'],
    disclosureMode: 'public-live',
  };
  batch.sourceSnapshotHash = researchBatchHash(batch);
  const proposal: ResearchProposalV2 = {
    kind: 'leak_review',
    basePolicyVersion: base.version,
    evidenceSnapshotHash: batch.sourceSnapshotHash,
    evidenceRefs: ['example'],
    counterEvidenceRefs: [],
    scope: {
      streets: ['preflop'],
      players: [2],
      positions: [],
      stackBuckets: [],
      betBuckets: [],
      opponentKeys: [],
      rulesetVersion: base.rulesetVersion,
      basePolicyVersion: base.version,
    },
    hypothesis: 'A free option existed.',
    suggestedGuidance: 'Consider the free check using the current facts.',
    metricRefs: ['observed'],
    limitations: ['Small sample.'],
    invalidateWhen: [],
    requiredScenarios: ['free-check'],
  };
  return { batch, proposal, ago };
}
export function publishFixture(advice: AdviceStore) {
  const { batch, proposal } = researchFixture();
  const record = advice.ingest(batch, proposal, {
    provider: 'controlled',
    requestedModel: 'fixture',
    actualModel: 'fixture',
  });
  advice.approve(record.proposalId, {
    actor: 'test-operator',
    note: 'Independent known free check scenario reviewed.',
    passedScenarios: [...REQUIRED_REVIEW_SCENARIOS, 'free-check'],
  });
  const publication = advice.publish(record.proposalId, {
    expectedRevision: 0,
    ttlMs: 3600000,
    actor: 'test-operator',
  });
  return { record, publication };
}
export function evaluationHands(store: Store) {
  const { ago } = researchFixture();
  store.beginRun({
    id: 'controlled',
    kind: 'live',
    strategy: 'jev',
    startedAt: ago(40),
    config: {},
  });
  for (let i = 0; i < 12; i++) {
    const handId = `evaluation-hand-${i}`;
    const at = ago(30 - i);
    const state = {
      ...createInitialState(),
      tableId: 'controlled-table',
      handId,
      turnToken: 'local-fixture-only',
      street: 'preflop' as const,
      heroSeat: 0,
      dealerSeat: 0,
      actorSeat: 0,
      holeCards: ['Ah', 'Kd'],
      bigBlind: 20,
      smallBlind: 10,
      pot: 30,
      historyIncomplete: false,
      seats: [
        { seat: 0, name: 'hero', stack: 1000, bet: 20, status: 'active', inHand: true },
        { seat: 1, name: 'opponent', stack: 1000, bet: 20, status: 'active', inHand: true },
      ],
      validActions: [{ action: 'check' as const }, { action: 'fold' as const }],
    };
    store.appendEvent(
      'controlled',
      { type: 'hand_start', hand_id: handId, table_id: state.tableId, table_seq: i + 1, ts: at },
      at,
    );
    const binding = store.pinKnowledge(state, at);
    const context = buildContext(state);
    const { opponents: _opponents, cards: _cards, ...snapshot } = binding.snapshot;
    context.knowledge = { pin: binding.pin, snapshot };
    const candidates = buildCandidates(state);
    store.db
      .prepare(
        `INSERT INTO hands(id,run_id,table_id,hand_number,board,hero_cards,profit,big_blind,status,started_at,ended_at,complete) VALUES(?,'controlled','controlled-table',?,'[]','[]',0,20,'complete',?,?,1)`,
      )
      .run(handId, i, at, at);
    store.db
      .prepare(
        `INSERT INTO decisions(id,run_id,hand_id,street,created_at,context,candidates,proposal,source,selected,status,latency_ms,cost_usd) VALUES(?,'controlled',?,'preflop',?,?,?,'{}','jev','check','accepted',1,0)`,
      )
      .run(`decision-${i}`, handId, at, JSON.stringify(context), JSON.stringify(candidates));
  }
}
