import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { AdviceStore } from '../src/knowledge/advice-store.js';
import { REQUIRED_REVIEW_SCENARIOS } from '../src/knowledge/advice-validator.js';
import { EvidenceBuilder } from '../src/research/evidence.js';
import { LlmResearchProvider } from '../src/research/llm-provider.js';
import { loadAsyncResearchConfig } from '../src/research/config.js';
import { JevProvider } from '../src/policies/jev.js';
import { authorityKey, decide } from '../src/evaluation/legacy/decision.js';
import { createInitialState } from '../src/core/state.js';
import type { PokerState, RawMessage } from '../src/core/types.js';
import type { ResearchBatchV2, ResearchProposalV2 } from '../src/research/contracts.js';
import { evaluationHands } from './helpers/research-fixture.js';

it('completed raw history → real batch builder → controlled LLM transport → approval → publication → next-hand Jev request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-research-chain-'));
  const store = new Store(join(directory, 'raw.sqlite'));
  const advice = new AdviceStore(join(directory, 'research.sqlite'));
  let builder: EvidenceBuilder | undefined;
  try {
    evaluationHands(store);
    const hands = store.db.prepare('SELECT id,ended_at FROM hands ORDER BY id').all();
    for (const [index, hand] of hands.entries()) {
      store.db
        .prepare('UPDATE hands SET profit=? WHERE id=?')
        .run((index % 3) - 1, String(hand.id));
      store.appendEvent(
        'controlled',
        {
          type: 'hand_result',
          table_id: 'controlled-table',
          hand_id: String(hand.id),
          ts: String(hand.ended_at),
          actions: [
            {
              seat: 1,
              street: 'preflop',
              action: index % 3 === 0 ? 'raise' : 'check',
              amount: index % 3 === 0 ? 40 : 0,
            },
          ],
          shown_cards: {},
        },
        String(hand.ended_at),
      );
    }
    builder = new EvidenceBuilder(store.filename);
    const cutoff = new Date(Date.now() - 2000).toISOString();
    const batch = builder.batches(cutoff).find((item) => item.taskType === 'opponent_brief')!;
    expect(batch).toBeDefined();
    expect(batch.eligibleHandIds).toHaveLength(12);
    expect(batch.metrics[0]).toMatchObject({ numerator: 4, denominator: 12 });
    expect(batch.examples.some((item) => item.phase === 'decision_visible')).toBe(true);
    expect(batch.examples.some((item) => item.phase === 'post_settlement')).toBe(true);
    const strata = new Set(
      batch.examples
        .filter((item) => item.phase === 'post_settlement')
        .map((item) =>
          Math.sign((JSON.parse(item.summary) as { profitChips: number }).profitChips),
        ),
    );
    expect([...strata].sort()).toEqual([-1, 0, 1]);

    store.adviceSource = { mode: () => 'live', bundle: (options) => advice.bundle(options) };
    const makeHand = (id: string, at: string): PokerState => {
      store.appendEvent(
        'controlled',
        { type: 'hand_start', table_id: 'chain-table', hand_id: id, ts: at },
        at,
      );
      return {
        ...createInitialState(),
        tableId: 'chain-table',
        handId: id,
        heroSeat: 0,
        dealerSeat: 0,
        actorSeat: 0,
        street: 'preflop',
        turnToken: `synthetic-${id}`,
        bigBlind: 20,
        smallBlind: 10,
        pot: 40,
        holeCards: ['Ah', 'Kd'],
        historyIncomplete: false,
        validActions: [{ action: 'check' }, { action: 'fold' }],
        seats: [
          { seat: 0, name: 'hero', stack: 1000, bet: 0, inHand: true, status: 'active' },
          { seat: 1, name: 'opponent', stack: 1000, bet: 0, inHand: true, status: 'active' },
        ],
      };
    };
    const current = makeHand(
      'current-before-publication',
      new Date(Date.now() - 1000).toISOString(),
    );
    const currentPin = store.pinKnowledge(current, new Date().toISOString());
    expect(currentPin.advice?.publications).toEqual([]);
    let llmCalls = 0;
    let observedBatchHash: string | undefined;
    const config = loadAsyncResearchConfig(
      {
        ASYNC_LLM_MODE: 'shadow',
        LLM_RESEARCH_PROVIDER: 'standard',
        LLM_RESEARCH_PROTOCOL: 'responses',
        LLM_RESEARCH_API_KEY: 'fixture-research-secret',
        LLM_RESEARCH_BASE_URL: 'https://controlled.invalid/v1',
        LLM_RESEARCH_MODEL: 'fixture-research',
        LLM_RESEARCH_MAX_RETRIES: '0',
      },
      store.filename,
    );
    const research = new LlmResearchProvider(config, undefined, async (_url, init) => {
      llmCalls++;
      const request = JSON.parse(String(init?.body)) as { input: string };
      const input = JSON.parse(request.input) as { batch: ResearchBatchV2 };
      observedBatchHash = input.batch.sourceSnapshotHash;
      expect(input.batch).toEqual(batch);
      expect(String(init?.body)).not.toContain('synthetic-current-before-publication');
      // The model fixture derives references from the actual transport input. It cannot approve itself.
      const returned: ResearchProposalV2 = {
        kind: input.batch.taskType,
        basePolicyVersion: input.batch.basePolicyVersion,
        evidenceSnapshotHash: input.batch.sourceSnapshotHash,
        evidenceRefs: [input.batch.examples[0]!.id],
        counterEvidenceRefs: [input.batch.examples[1]!.id],
        scope: {
          streets: ['preflop'],
          players: [2],
          positions: [],
          stackBuckets: [],
          betBuckets: [],
          opponentKeys: [input.batch.scopeKey],
          rulesetVersion: input.batch.rulesetVersion,
          basePolicyVersion: input.batch.basePolicyVersion,
        },
        hypothesis: 'Observed actions vary.',
        suggestedGuidance: 'Use the current price and observed line.',
        metricRefs: [input.batch.metrics[0]!.id],
        limitations: ['Limited sample.'],
        invalidateWhen: [],
        requiredScenarios: ['known-opportunity-denominator'],
      };
      return Response.json({
        model: config.model,
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(returned) }] },
        ],
        usage: { input_tokens: 321, output_tokens: 87 },
      });
    });
    const response = await research.propose(batch, new AbortController().signal);
    expect(response.insufficient).toBe(false);
    expect(response.attempts).toHaveLength(1);
    expect(response.attempts[0]?.status).toBe('succeeded');
    const record = advice.ingest(batch, response.raw, response.model);
    expect(record.status).toBe('pending');
    expect(
      advice.bundle({
        mode: 'live',
        basePolicyVersion: batch.basePolicyVersion,
        admissibleAt: new Date().toISOString(),
      }).publications,
    ).toEqual([]);
    // Trusted test reviewer checks the known counted opportunities, separately from model prose.
    expect(record.batch.metrics[0]?.numerator).toBe(4);
    expect(record.batch.metrics[0]?.denominator).toBe(hands.length);
    advice.approve(record.proposalId, {
      actor: 'controlled-independent-reviewer',
      note: 'Known completed fixture counts and bounded scope independently verified.',
      passedScenarios: [...REQUIRED_REVIEW_SCENARIOS, 'known-opportunity-denominator'],
    });
    const published = advice.publish(record.proposalId, {
      expectedRevision: 0,
      ttlMs: 3600000,
      actor: 'controlled-independent-reviewer',
    });
    store.refreshKnowledge();
    expect(store.pinKnowledge(current, new Date().toISOString())).toBe(currentPin);
    const next = makeHand('next-after-publication', new Date().toISOString());
    const nextPin = store.pinKnowledge(next, new Date().toISOString());
    expect(nextPin.advice?.publications.map((item) => item.publicationId)).toEqual([
      published.publicationId,
    ]);
    expect(Date.parse(nextPin.pin.bundleAvailableAt!)).toBeLessThanOrEqual(
      Date.parse(nextPin.pin.admissibleAt),
    );
    const jevRequests: string[] = [];
    const jev = new JevProvider({
      apiKey: 'fixture-jev-secret',
      fetch: async (_url, init) => {
        jevRequests.push(String(init?.body));
        const body = JSON.parse(String(init?.body)) as {
          questions: { action: { criteria: Record<string, unknown> } };
        };
        const ids = Object.keys(body.questions.action.criteria);
        return Response.json({
          model: 'fixture-jev',
          usage: { input_tokens: 111, output_tokens: 1 },
          answers: {
            action: {
              type: 'choice',
              choice: 'check',
              confidence: 1,
              probabilities: Object.fromEntries(ids.map((id) => [id, id === 'check' ? 1 : 0])),
            },
          },
        });
      },
    });
    const choose = (state: PokerState) =>
      decide(
        {
          key: authorityKey(state),
          state,
          controller: new AbortController(),
          deadlineAt: Date.now() + 5000,
          recovered: false,
          requireJev: true,
          opponents: [],
        },
        { store, policy: jev, apiKey: 'unused-fixture' },
        'controlled',
        3000,
      );
    const priorResult = await choose(current);
    expect(jevRequests).toHaveLength(1);
    expect(JSON.parse(jevRequests[0]!).state.approvedAdvice).toBeUndefined();
    const result = await choose(next);
    expect(jevRequests).toHaveLength(2);
    expect(result?.action?.decisionSource).toBe('jev');
    expect(result?.decision.proposal.attempts).toHaveLength(1);
    expect(priorResult?.action?.decisionSource).toBe('jev');
    const request = JSON.parse(jevRequests[1]!) as { state: RawMessage };
    expect(request.state.approvedAdvice).toEqual([
      expect.objectContaining({
        guidance: record.proposal.suggestedGuidance,
        scope: { streets: ['preflop'], opponentSeats: [1] },
      }),
    ]);
    expect(result?.decision.context.advice?.proposalIds).toEqual([record.proposalId]);
    expect(result?.decision.context.advice?.publicationIds).toEqual([published.publicationId]);
    expect(result?.decision.proposal.requestHash).toBe(
      createHash('sha256').update(jevRequests[1]!).digest('hex'),
    );
    expect(llmCalls).toBe(1);
    expect(observedBatchHash).toBe(batch.sourceSnapshotHash);
    const destination = process.env.ASYNC_CHAIN_OUTPUT;
    if (destination) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            kind: 'controlled_vertical_acceptance',
            completedEvidenceHands: hands.length,
            evidenceEventWatermark: batch.evidenceEventWatermark,
            evidenceSnapshotHash: batch.sourceSnapshotHash,
            batchId: batch.batchId,
            proposalId: record.proposalId,
            publicationId: published.publicationId,
            bundleHash: nextPin.pin.bundleHash,
            adviceBundleHash: result?.decision.context.advice?.bundleHash,
            requestHash: result?.decision.proposal.requestHash,
            researchCalls: llmCalls,
            jevCalls: jevRequests.length,
            jevCallsPerAction: 1,
            assertions: {
              rawEvidenceBuilder: true,
              allOutcomeStrata: true,
              actualResearchTransport: true,
              manualApprovalRequired: true,
              currentHandUnchanged: true,
              archivedBeforeNextHand: true,
              actualNextJevRequestAdopted: true,
              onlyJevActions: true,
            },
            limitations: [
              'All historical hands, reviewer and model responses are controlled fixtures.',
              'No paid API call, public Arena connection, deployment or profitability evaluation.',
              'This artifact contains whitelisted synthetic identifiers and hashes, not credentials or raw prompts.',
            ],
          },
          null,
          2,
        ),
      );
    }
  } finally {
    builder?.close();
    advice.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
