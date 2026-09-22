import { afterEach, describe, expect, it } from 'vitest';
import { applyAdvice } from '../src/core/advice.js';
import { buildCandidates } from '../src/core/candidates.js';
import { buildContext } from '../src/core/context.js';
import { projectJevState } from '../src/core/harness.js';
import { createInitialState } from '../src/core/state.js';
import type { PokerState } from '../src/core/types.js';
import { AdviceStore, APPROVED_RECIPE_ID } from '../src/knowledge/advice-store.js';
import { selectAdvice } from '../src/knowledge/advice-selector.js';
import {
  opponentKey,
  researchBatchHash,
  REQUIRED_REVIEW_SCENARIOS,
} from '../src/knowledge/advice-validator.js';
import { KNOWLEDGE_CONTEXT_VERSION, RULESET_VERSION } from '../src/knowledge/validator.js';
import { JevProvider } from '../src/policies/jev.js';
import type { ResearchBatchV2, ResearchProposalV2 } from '../src/research/contracts.js';

const now = '2026-09-22T10:00:00.000Z';
const basePolicyVersion = 'poker-knowledge-base-v1';
const opponent = opponentKey('fixture-villain');
const stores: AdviceStore[] = [];
const approval = {
  actor: 'reviewer',
  note: 'Reviewed fixed template and complete count evidence.',
};
const publicationOptions = { expectedRevision: 0, ttlMs: 60_000, actor: 'recipe-worker' };
const model = {
  provider: 'fixture',
  requestedModel: 'deepseek-flash',
  actualModel: 'deepseek-flash',
};
const match = {
  street: 'preflop',
  players: 2,
  opponentKeys: [opponent],
  rulesetVersion: RULESET_VERSION,
  basePolicyVersion,
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function open() {
  const store = new AdviceStore(':memory:', { clock: () => new Date(now) });
  stores.push(store);
  return store;
}
function batch(): ResearchBatchV2 {
  const handIds = Array.from({ length: 61 }, (_, index) => `completed-${index}`);
  // Counts and metric names reproduce the real four-street research output that exceeded v1's cap.
  const streets = [
    { street: 'preflop', numerator: 3, denominator: 59 },
    { street: 'flop', numerator: 4, denominator: 13 },
    { street: 'turn', numerator: 3, denominator: 12 },
    { street: 'river', numerator: 1, denominator: 4 },
  ];
  const content: ResearchBatchV2 = {
    batchId: 'four-street-batch',
    taskType: 'opponent_brief',
    scopeKey: opponent,
    basePolicyVersion,
    researchPromptVersion: 'research-v2',
    inputSchemaVersion: 'research-batch-v2',
    rulesetVersion: RULESET_VERSION,
    contextSchemaVersion: KNOWLEDGE_CONTEXT_VERSION,
    sourceSnapshotHash: '0'.repeat(64),
    evidenceEventWatermark: 100,
    cutoff: '2026-09-22T09:59:00.000Z',
    eligibleHandIds: handIds,
    metrics: streets.map(({ street, numerator, denominator }) => ({
      id: `${street}-raises`,
      name: `${street}_raises_among_observed_actions`,
      numerator,
      denominator,
      opponentKey: opponent,
      handIds,
      throughEventId: 100,
      availableAt: '2026-09-22T09:58:00.000Z',
    })),
    examples: [
      {
        id: 'observed-line',
        handId: handIds[0]!,
        eventId: 100,
        availableAt: '2026-09-22T09:58:00.000Z',
        opponentKey: opponent,
        phase: 'post_settlement',
        summary: 'Observed actions without unrevealed cards.',
      },
    ],
    sampleDefinition: 'Completed hands across all streets.',
    missingness: ['Unshown cards remain unknown.'],
    disclosureMode: 'public-current-hand',
  };
  content.sourceSnapshotHash = researchBatchHash(content);
  return content;
}
function proposal(evidence: ResearchBatchV2): ResearchProposalV2 {
  return {
    kind: 'opponent_brief',
    basePolicyVersion,
    evidenceSnapshotHash: evidence.sourceSnapshotHash,
    evidenceRefs: ['observed-line'],
    counterEvidenceRefs: [],
    metricRefs: evidence.metrics.map(({ id }) => id),
    scope: {
      streets: ['preflop', 'flop', 'turn', 'river'],
      players: [2, 3, 4, 5, 6],
      positions: [],
      stackBuckets: [],
      betBuckets: [],
      opponentKeys: [opponent],
      rulesetVersion: RULESET_VERSION,
      basePolicyVersion,
    },
    hypothesis: 'Recorded raises vary by street.',
    suggestedGuidance: 'Model free text must not replace the trusted template.',
    limitations: ['Conditional counts do not identify hidden ranges.'],
    invalidateWhen: [
      { kind: 'opponent_absent' },
      { kind: 'metric_below', metricRef: 'turn-raises', threshold: 0.1 },
    ],
    proposedRecipeId: APPROVED_RECIPE_ID,
    requiredScenarios: ['no-hidden-cards'],
  };
}
function bundle(store: AdviceStore) {
  return store.bundle({ mode: 'live', basePolicyVersion, admissibleAt: now });
}
function state(): PokerState {
  return {
    ...createInitialState(),
    tableId: 'table',
    handId: 'next-hand',
    street: 'preflop',
    heroSeat: 0,
    dealerSeat: 0,
    actorSeat: 0,
    turnToken: 'next-turn',
    bigBlind: 10,
    smallBlind: 5,
    pot: 20,
    holeCards: ['As', 'Kd'],
    validActions: [{ action: 'check' }],
    seats: [
      { seat: 0, name: 'hero', stack: 1000, bet: 0, status: 'active', inHand: true },
      { seat: 1, name: 'fixture-villain', stack: 1000, bet: 0, status: 'active', inHand: true },
    ],
  };
}

describe('compact approved recipe publication', () => {
  it('retains all four real street counts through publication, selection and the actual Jev request', async () => {
    const store = open();
    const evidence = batch();
    const original = proposal(evidence);
    const record = store.ingest(evidence, original, model);
    store.approveRecipe(approval);
    const published = store.publishApprovedRecipe(record.proposalId, publicationOptions);
    expect(published.metrics).toEqual(evidence.metrics);
    expect(store.getProposal(record.proposalId)?.proposal).toEqual(record.proposal);
    const fixed = bundle(store);
    const selected = selectAdvice(fixed, match);
    expect(selected.audit).toEqual([{ id: published.publicationId, reason: 'adopted' }]);
    const expectedEvidence = [
      'preflop_raises_among_observed_actions: 3/59',
      'flop_raises_among_observed_actions: 4/13',
      'turn_raises_among_observed_actions: 3/12',
      'river_raises_among_observed_actions: 1/4',
    ];
    expect(selected.items[0]?.evidence).toEqual(expectedEvidence);
    const current = state();
    const context = buildContext(current, [], { asOf: now });
    applyAdvice(context, fixed);
    expect(projectJevState(context).approvedAdvice).toEqual([
      expect.objectContaining({
        evidence: expectedEvidence,
        guidance: published.guidance,
        scope: { streets: published.scope.streets, opponentSeats: [1] },
      }),
    ]);
    const requests: string[] = [];
    const provider = new JevProvider({
      apiKey: 'fixture-key',
      fetch: async (_url, init) => {
        const body = String(init?.body);
        requests.push(body);
        const request = JSON.parse(body) as {
          questions: { action: { criteria: Record<string, unknown> } };
        };
        const choices = Object.keys(request.questions.action.criteria);
        return new Response(
          JSON.stringify({
            model: 'jev-fixture',
            usage: { input_tokens: 10, output_tokens: 1 },
            answers: {
              action: {
                type: 'choice',
                choice: choices[0],
                confidence: 1,
                probabilities: Object.fromEntries(
                  choices.map((choice, index) => [choice, index === 0 ? 1 : 0]),
                ),
              },
            },
          }),
          { status: 200 },
        );
      },
    });
    await provider.decide(context, buildCandidates(current));
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!).state.approvedAdvice[0].evidence).toEqual(expectedEvidence);
    expect(requests[0]).not.toContain(original.suggestedGuidance);
    expect(context.advice?.publicationIds).toEqual([published.publicationId]);
    expect(selectAdvice(fixed, { ...match, opponentKeys: [] }).items).toEqual([]);
  });

  it('does not reuse v1 approval or silently upgrade a pending v1 proposal', () => {
    const store = open();
    store.db
      .prepare('INSERT INTO advice_recipes(id,actor,approved_ms,note) VALUES(?,?,?,?)')
      .run('opponent-evidence-v1', approval.actor, Date.parse(now), approval.note);
    const evidence = batch();
    const current = store.ingest(evidence, proposal(evidence), model);
    expect(() => store.publishApprovedRecipe(current.proposalId, publicationOptions)).toThrow(
      /prior operator approval/,
    );
    expect(store.getProposal(current.proposalId)?.status).toBe('pending');
    const legacy = store.ingest(
      evidence,
      { ...proposal(evidence), proposedRecipeId: 'opponent-evidence-v1' },
      model,
    );
    store.approveRecipe(approval);
    expect(() => store.publishApprovedRecipe(legacy.proposalId, publicationOptions)).toThrow(
      /eligible pending/,
    );
    expect(store.getProposal(legacy.proposalId)).toEqual(legacy);
    expect(store.listPublications()).toEqual([]);
    expect(store.publishApprovedRecipe(current.proposalId, publicationOptions).approvalSource).toBe(
      'approved_recipe',
    );
  });

  it('rolls back oversized automatic publication without mutating or truncating pending evidence', () => {
    const store = open();
    const evidence = batch();
    evidence.metrics.forEach((metric) => {
      metric.name = 'Long_verified_metric_'.repeat(7);
    });
    evidence.sourceSnapshotHash = researchBatchHash(evidence);
    const record = store.ingest(evidence, proposal(evidence), model);
    store.approveRecipe(approval);
    const auditBefore = store.listAudit();
    expect(() => store.publishApprovedRecipe(record.proposalId, publicationOptions)).toThrow(
      /character limit/,
    );
    expect(store.getProposal(record.proposalId)).toEqual(record);
    expect(store.listPublications()).toEqual([]);
    expect(store.listAudit()).toEqual(auditBefore);
    expect(bundle(store).publications).toEqual([]);
  });

  it('counts Unicode code points consistently with the selector rather than UTF16 units', () => {
    const store = open();
    const evidence = batch();
    evidence.metrics = [
      { ...evidence.metrics[0]!, name: '🂡'.repeat(80) },
      { ...evidence.metrics[1]!, name: '🂢'.repeat(70) },
    ];
    evidence.sourceSnapshotHash = researchBatchHash(evidence);
    const raw = proposal(evidence);
    raw.invalidateWhen = [];
    const record = store.ingest(evidence, raw, model);
    store.approveRecipe(approval);
    store.publishApprovedRecipe(record.proposalId, publicationOptions);
    expect(selectAdvice(bundle(store), match).items[0]?.evidence).toEqual([
      `${'🂡'.repeat(80)}: 3/59`,
      `${'🂢'.repeat(70)}: 4/13`,
    ]);
  });

  it('leaves an existing legacy proposal publication and frozen bundle byte-for-byte unchanged on recipe approval', () => {
    const store = open();
    const evidence = batch();
    const raw = { ...proposal(evidence), proposedRecipeId: 'opponent-evidence-v1' };
    const record = store.ingest(evidence, raw, model);
    store.approve(record.proposalId, {
      ...approval,
      passedScenarios: [...REQUIRED_REVIEW_SCENARIOS, 'no-hidden-cards'],
    });
    const published = store.publish(record.proposalId, publicationOptions);
    const original = JSON.stringify(bundle(store));
    const before = store.db
      .prepare('SELECT payload FROM advice_publications WHERE id=?')
      .get(published.publicationId)?.payload;
    store.approveRecipe(approval);
    expect(JSON.stringify(bundle(store))).toBe(original);
    expect(
      store.db
        .prepare('SELECT payload FROM advice_publications WHERE id=?')
        .get(published.publicationId)?.payload,
    ).toBe(before);
    expect(store.getProposal(record.proposalId)?.proposal.proposedRecipeId).toBe(
      'opponent-evidence-v1',
    );
  });
});
