import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import { buildContext } from '../src/core/context.js';
import { buildCandidates } from '../src/core/candidates.js';
import { applyAdvice } from '../src/core/advice.js';
import { projectJevState } from '../src/core/harness.js';
import type { PokerState, RawMessage } from '../src/core/types.js';
import { AdviceStore } from '../src/knowledge/advice-store.js';
import type { AsyncLlmMode, PublishedAdvice } from '../src/knowledge/advice-types.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import {
  opponentKey,
  researchBatchHash,
  REQUIRED_REVIEW_SCENARIOS,
} from '../src/knowledge/advice-validator.js';
import { RULESET_VERSION, KNOWLEDGE_CONTEXT_VERSION } from '../src/knowledge/validator.js';
import { JevProvider } from '../src/policies/jev.js';
import type { ResearchBatchV2, ResearchProposalV2 } from '../src/research/contracts.js';
import { authorityKey, decide } from '../src/runtime/decision.js';
import { pinKnowledge } from '../src/storage/knowledge.js';
import { Store } from '../src/storage/store.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const epoch = Date.now() - 120_000;
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const basePolicyVersion = baselineSnapshot().version;
const key = opponentKey('villain');
function evidence(): ResearchBatchV2 {
  const content = {
    batchId: 'batch',
    taskType: 'opponent_brief' as const,
    scopeKey: key,
    basePolicyVersion,
    researchPromptVersion: 'test-v1',
    inputSchemaVersion: 'research-batch-v2' as const,
    rulesetVersion: RULESET_VERSION,
    contextSchemaVersion: KNOWLEDGE_CONTEXT_VERSION,
    evidenceEventWatermark: 10,
    cutoff: at(1),
    eligibleHandIds: ['prior'],
    metrics: [
      {
        id: 'vpip',
        name: 'Observed entry',
        numerator: 1,
        denominator: 1,
        opponentKey: key,
        handIds: ['prior'],
        throughEventId: 10,
        availableAt: at(0),
      },
    ],
    examples: [
      {
        id: 'example',
        handId: 'prior',
        eventId: 10,
        availableAt: at(0),
        opponentKey: key,
        phase: 'post_settlement' as const,
        summary: 'Called preflop; no cards shown.',
      },
    ],
    sampleDefinition: 'One completed hand for controlled integration test.',
    missingness: ['No showdown'],
    disclosureMode: 'public-current-hand',
  };
  return { ...content, sourceSnapshotHash: researchBatchHash(content) };
}
function proposal(
  batch: ResearchBatchV2,
  guidance = 'Use price and the current betting line; the sample is limited.',
): ResearchProposalV2 {
  return {
    kind: 'opponent_brief',
    basePolicyVersion,
    evidenceSnapshotHash: batch.sourceSnapshotHash,
    evidenceRefs: ['example'],
    counterEvidenceRefs: [],
    metricRefs: ['vpip'],
    scope: {
      streets: ['preflop'],
      players: [2],
      positions: [],
      stackBuckets: [],
      betBuckets: [],
      opponentKeys: [key],
      rulesetVersion: RULESET_VERSION,
      basePolicyVersion,
    },
    hypothesis: 'Entry was observed.',
    suggestedGuidance: guidance,
    limitations: ['Unshown cards limit inference.'],
    invalidateWhen: [],
    requiredScenarios: ['no-hidden-cards'],
  };
}
function setup(mode: AsyncLlmMode = 'live', persistent = false) {
  let clock = at(2);
  const directory = mkdtempSync(join(tmpdir(), 'jev-advice-pin-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = persistent ? join(directory, 'raw.sqlite') : ':memory:';
  const store = new Store(path);
  cleanup.push(() => store.close());
  const advice = new AdviceStore(':memory:', { clock: () => new Date(clock) });
  cleanup.push(() => advice.close());
  let selectedMode = mode;
  store.adviceSource = {
    mode: () => selectedMode,
    bundle: (options) => {
      clock = options.admissibleAt;
      return advice.bundle(options);
    },
  };
  store.beginRun({ id: 'run', kind: 'live', strategy: 'jev', startedAt: at(0), config: {} });
  const publish = (second: number, guidance?: string, expectedRevision = 0): PublishedAdvice => {
    clock = at(second);
    const batch = evidence();
    const record = advice.ingest(batch, proposal(batch, guidance), {
      provider: 'controlled',
      requestedModel: 'fixture',
      actualModel: 'fixture',
    });
    advice.approve(record.proposalId, {
      actor: 'test-reviewer',
      note: 'Independent controlled fixture checked.',
      passedScenarios: [...REQUIRED_REVIEW_SCENARIOS, 'no-hidden-cards'],
    });
    return advice.publish(record.proposalId, {
      expectedRevision,
      ttlMs: 3600000,
      actor: 'test-reviewer',
    });
  };
  const hand = (id: string, second: number): PokerState => {
    store.appendEvent(
      'run',
      { type: 'hand_start', table_id: 'table', hand_id: id, ts: at(second) },
      at(second),
    );
    return {
      ...createInitialState(),
      tableId: 'table',
      handId: id,
      street: 'preflop',
      heroSeat: 0,
      dealerSeat: 0,
      actorSeat: 0,
      turnToken: `turn-${id}`,
      bigBlind: 10,
      smallBlind: 5,
      pot: 20,
      holeCards: ['As', 'Kd'],
      validActions: [{ action: 'check' }],
      seats: [
        { seat: 0, name: 'hero', stack: 1000, bet: 0, status: 'active', inHand: true },
        { seat: 1, name: 'villain', stack: 1000, bet: 0, status: 'active', inHand: true },
      ],
    };
  };
  return {
    store,
    advice,
    path,
    publish,
    hand,
    setMode: (next: AsyncLlmMode) => {
      selectedMode = next;
    },
    setClock: (second: number) => {
      clock = at(second);
    },
  };
}
function provider(requests: string[]) {
  return new JevProvider({
    apiKey: 'controlled-key',
    fetch: async (_url, init) => {
      requests.push(String(init?.body));
      const request = JSON.parse(String(init?.body)) as {
        questions: { action: { criteria: Record<string, unknown> } };
      };
      const ids = Object.keys(request.questions.action.criteria);
      const choice = ids[0]!;
      return new Response(
        JSON.stringify({
          model: 'jev-controlled',
          usage: { input_tokens: 10, output_tokens: 1 },
          answers: {
            action: {
              type: 'choice',
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
            },
          },
        }),
        { status: 200 },
      );
    },
  });
}
async function action(store: Store, state: PokerState, requests: string[]) {
  return decide(
    {
      key: authorityKey(state),
      state,
      controller: new AbortController(),
      deadlineAt: Date.now() + 5000,
      recovered: false,
      opponents: [],
      requireJev: true,
    },
    { store, policy: provider(requests), apiKey: 'not-used' },
    'run',
    3000,
  );
}

describe('approved advice → authoritative pin → real Jev request boundary', () => {
  it('publishes reviewed evidence and adopts it in the actual Jev fetch with complete request lineage', async () => {
    const test = setup();
    const published = test.publish(2);
    test.store.refreshKnowledge(at(3));
    const state = test.hand('h1', 4);
    const binding = test.store.pinKnowledge(state, at(4));
    const requests: string[] = [];
    const result = await action(test.store, state, requests);
    expect(result?.action?.decisionSource).toBe('jev');
    expect(requests).toHaveLength(1);
    const actual = JSON.parse(requests[0]!) as { state: RawMessage };
    expect(actual.state.approvedAdvice).toEqual([
      expect.objectContaining({ guidance: published.guidance }),
    ]);
    expect(JSON.stringify(actual)).not.toContain(published.proposalId);
    expect(result?.decision.context.advice?.publicationIds).toEqual([published.publicationId]);
    expect(result?.decision.context.advice?.proposalIds).toEqual([published.proposalId]);
    expect(result?.decision.proposal.requestHash).toBe(
      createHash('sha256').update(requests[0]!).digest('hex'),
    );
    const row = test.store.db
      .prepare('SELECT payload FROM hand_knowledge WHERE hand_id=?')
      .get('h1');
    expect(JSON.parse(String(row?.payload)).schemaVersion).toBe('hand-knowledge-v2');
    expect(JSON.parse(String(row?.payload)).snapshot).toBeUndefined();
    expect(binding.pin.bundleAvailableAt).toBe(at(3));
  });
  it('keeps the same hand and mode fixed while publications change; next hand sees the new revision', async () => {
    const test = setup();
    const first = test.publish(2);
    test.store.refreshKnowledge(at(3));
    const state = test.hand('h1', 4);
    test.store.pinKnowledge(state, at(4));
    const second = test.publish(
      5,
      'Treat the observation as conditional and weigh the current price.',
      1,
    );
    test.store.refreshKnowledge(at(6));
    let result = await action(test.store, state, []);
    expect(result?.decision.context.advice?.publicationIds).toEqual([first.publicationId]);
    const next = test.hand('h2', 7);
    test.store.pinKnowledge(next, at(7));
    result = await action(test.store, next, []);
    expect(result?.decision.context.advice?.publicationIds).toEqual([second.publicationId]);
    test.setMode('off');
    test.store.refreshKnowledge(at(8));
    result = await action(test.store, next, []);
    expect(result?.decision.context.advice?.mode).toBe('live');
    const off = test.hand('h3', 9);
    test.store.pinKnowledge(off, at(9));
    const requests: string[] = [];
    result = await action(test.store, off, requests);
    expect(result?.decision.context.advice?.mode).toBe('off');
    expect(requests[0]).not.toContain('approvedAdvice');
  });
  it('withdrawal reactivates an already archived empty bundle only for subsequent hands', async () => {
    const test = setup();
    test.store.refreshKnowledge(at(1));
    const published = test.publish(2);
    test.store.refreshKnowledge(at(3));
    const current = test.hand('h1', 4);
    test.store.pinKnowledge(current, at(4));
    test.setClock(5);
    test.advice.withdraw(published.publicationId, {
      actor: 'test-reviewer',
      note: 'Withdraw test recommendation.',
    });
    test.store.refreshKnowledge(at(6));
    expect(
      (await action(test.store, current, []))?.decision.context.advice?.publicationIds,
    ).toEqual([published.publicationId]);
    const next = test.hand('h2', 7);
    test.store.pinKnowledge(next, at(7));
    expect((await action(test.store, next, []))?.decision.context.advice?.items).toEqual([]);
  });
  it('uses actual local archive availability, not backdated upstream publication time', () => {
    const test = setup();
    test.publish(2);
    test.store.refreshKnowledge(at(6));
    const old = test.hand('old', 4);
    const binding = test.store.pinKnowledge(old, at(7));
    expect(binding.advice?.publications).toEqual([]);
    const next = test.hand('new', 8);
    expect(test.store.pinKnowledge(next, at(8)).advice?.publications).toHaveLength(1);
  });
  it('recovers pinned full knowledge after a process restart without the derived research database', async () => {
    const test = setup('live', true);
    const published = test.publish(2);
    test.store.refreshKnowledge(at(3));
    const state = test.hand('h1', 4);
    const initial = test.store.pinKnowledge(state, at(4));
    const reopened = new Store(test.path);
    cleanup.push(() => reopened.close());
    reopened.adviceSource = {
      mode: () => {
        throw new Error('Derived database gone');
      },
      bundle: () => {
        throw new Error('Derived database gone');
      },
    };
    expect(reopened.pinKnowledge(state, at(6))).toEqual(initial);
    expect((await action(reopened, state, []))?.decision.context.advice?.publicationIds).toEqual([
      published.publicationId,
    ]);
  });
  it.each(['missing', 'corrupt'] as const)(
    'fails closed and records a durable stop when a pinned archive is %s',
    (kind) => {
      const test = setup('live', true);
      test.publish(2);
      test.store.refreshKnowledge(at(3));
      const state = test.hand('h1', 4);
      const binding = test.store.pinKnowledge(state, at(4));
      if (kind === 'missing') {
        test.store.db
          .prepare('DELETE FROM knowledge_archive_publications WHERE bundle_hash=?')
          .run(binding.pin.bundleHash!);
        test.store.db
          .prepare('DELETE FROM knowledge_archives WHERE bundle_hash=?')
          .run(binding.pin.bundleHash!);
      } else
        test.store.db
          .prepare("UPDATE knowledge_archives SET payload='{}' WHERE bundle_hash=?")
          .run(binding.pin.bundleHash!);
      const reopened = new Store(test.path);
      cleanup.push(() => reopened.close());
      expect(() => reopened.pinKnowledge(state, at(6))).toThrow('knowledge_integrity');
      expect(reopened.loadDecisionBlock()?.reason).toContain('knowledge_integrity');
    },
  );
  it('retains old full bindings and hashes without rewriting them', () => {
    const test = setup();
    test.store.adviceSource = undefined;
    const state = test.hand('old', 4);
    const first = test.store.pinKnowledge(state, at(4));
    const before = test.store.db.prepare('SELECT payload FROM hand_knowledge').get()?.payload;
    const restored = pinKnowledge(test.store.db, state, at(6), undefined, {
      mode: () => 'live',
      bundle: () => {
        throw new Error('Must not repin');
      },
    });
    expect(restored).toEqual(first);
    expect(test.store.db.prepare('SELECT payload FROM hand_knowledge').get()?.payload).toBe(before);
  });
  it('off and shadow produce byte-identical actual Jev bodies with the same frozen facts', async () => {
    const test = setup();
    test.publish(2);
    const state = test.hand('h1', 4);
    const requests: string[] = [];
    test.setClock(4);
    for (const mode of ['off', 'shadow'] as const) {
      const context = buildContext(state, [], { asOf: at(4) });
      applyAdvice(context, test.advice.bundle({ mode, basePolicyVersion, admissibleAt: at(4) }));
      await provider(requests).decide(context, buildCandidates(state));
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]).not.toContain('approvedAdvice');
  });
  it('matches only the fixed bundle when identity arrives late and excludes out-of-scope streets', async () => {
    const test = setup();
    const first = test.publish(2);
    test.store.refreshKnowledge(at(3));
    const state = test.hand('h1', 4);
    state.seats[1]!.name = null;
    test.store.pinKnowledge(state, at(4));
    expect((await action(test.store, state, []))?.decision.context.advice?.items).toEqual([]);
    test.publish(5, 'Newer advice must wait for the next hand.', 1);
    test.store.refreshKnowledge(at(6));
    state.seats[1]!.name = 'villain';
    expect((await action(test.store, state, []))?.decision.context.advice?.publicationIds).toEqual([
      first.publicationId,
    ]);
    state.street = 'flop';
    expect((await action(test.store, state, []))?.decision.context.advice?.audit).toEqual([
      { id: first.publicationId, reason: 'street_mismatch' },
    ]);
  });
  it.each(['pinnedAt', 'admissibleAt', 'bundleAvailableAt'] as const)(
    'rejects malformed stored %s instead of silently choosing a new pin',
    (field) => {
      const test = setup('live', true);
      test.publish(2);
      test.store.refreshKnowledge(at(3));
      const state = test.hand('h1', 4);
      test.store.pinKnowledge(state, at(4));
      const row = test.store.db
        .prepare('SELECT payload FROM hand_knowledge WHERE hand_id=?')
        .get('h1');
      const stored = JSON.parse(String(row!.payload));
      stored.pin[field] = 'not-a-time';
      test.store.db
        .prepare('UPDATE hand_knowledge SET payload=? WHERE hand_id=?')
        .run(JSON.stringify(stored), 'h1');
      const reopened = new Store(test.path);
      cleanup.push(() => reopened.close());
      expect(() => reopened.pinKnowledge(state, at(6))).toThrow('knowledge_integrity');
      expect(reopened.loadDecisionBlock()).not.toBeNull();
    },
  );
  it('drops advice before necessary current facts when the request context is too large', () => {
    const test = setup();
    const published = test.publish(2);
    test.setClock(4);
    const state = test.hand('h1', 4);
    const context = buildContext(state, [], { asOf: at(4) });
    context.history = Array.from({ length: 300 }, () => ({
      seat: 1,
      action: 'call' as const,
      street: 'preflop' as const,
      amount: 10,
      toCallBefore: 10,
      tableSeq: 1,
      streetSource: 'event' as const,
      handId: state.handId,
      name: 'villain',
      actionId: null,
      timestamp: at(4),
    }));
    applyAdvice(
      context,
      test.advice.bundle({ mode: 'live', basePolicyVersion, admissibleAt: at(4) }),
    );
    expect(context.advice?.publicationIds).toEqual([published.publicationId]);
    const projected = projectJevState(context);
    expect(projected.approvedAdvice).toBeUndefined();
    expect(projected.currentHandActions as unknown[]).toHaveLength(300);
    expect(projected.holeCards).toEqual(state.holeCards);
    expect(context.advice?.publicationIds).toEqual([]);
    expect(context.advice?.proposalIds).toEqual([]);
    expect(context.advice?.audit).toEqual([
      { id: published.publicationId, reason: 'context_size_limit' },
    ]);
  });
});
