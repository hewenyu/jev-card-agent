import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../src/core/state.js';
import type { OpponentMemory } from '../src/core/opponent-memory.js';
import { KnowledgeStore, baselineSnapshot } from '../src/knowledge/store.js';
import { snapshotHash } from '../src/knowledge/validator.js';
import type { KnowledgeSnapshot } from '../src/knowledge/types.js';
import { SlowLoopService } from '../src/research/service.js';
import { Store } from '../src/storage/store.js';
import type { KnowledgeSource } from '../src/storage/knowledge.js';
import { authorityKey, decide } from '../src/runtime/decision.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
function snapshot(
  watermark: number,
  publishedAt: string,
  opponents: OpponentMemory[] = [],
): KnowledgeSnapshot {
  const { contentHash: _hash, ...base } = baselineSnapshot();
  const content = {
    ...base,
    version: `review-v${watermark}`,
    source: 'deterministic' as const,
    evidenceEventId: watermark,
    evidenceCutoff: publishedAt,
    publishedAt,
    opponents,
  };
  return { ...content, contentHash: snapshotHash(content) };
}
function setup() {
  const store = new Store(':memory:');
  cleanup.push(() => store.close());
  store.beginRun({ id: 'run', kind: 'live', strategy: 'jev', startedAt: at(0), config: {} });
  store.appendEvent(
    'run',
    { type: 'hand_start', table_id: 'table', hand_id: 'hand', ts: at(2) },
    at(4),
  );
  const state = {
    ...createInitialState(),
    tableId: 'table',
    handId: 'hand',
    heroSeat: 0,
    actorSeat: 0,
    turnToken: 'turn',
    validActions: [{ action: 'check' as const }],
    seats: [{ seat: 0, name: 'hero', stack: 100, bet: 0, status: 'active' }],
  };
  return { store, state };
}
function source(latest: KnowledgeSource['latest']): KnowledgeSource {
  return {
    latest,
    getAudit: () => null,
    status: () => ({
      enabled: false,
      running: false,
      lastCompletedAt: null,
      eventCursor: 0,
      decisionCursor: 0,
      pendingHands: 0,
      pendingAudits: 0,
      latestVersion: 'unused',
      error: null,
    }),
  };
}
function memory(name: string): OpponentMemory {
  const street = {
    observedActions: 1,
    raises: 0,
    calls: 1,
    checks: 0,
    folds: 0,
    allIns: 0,
    facedBetObserved: 1,
    foldedToObservedBet: 0,
    sizedContributions: 1,
    contributionToPotSum: 0.5,
  };
  return {
    version: 'completed-opponent-encounters-v1',
    name,
    asOf: at(1),
    sampledHands: 1,
    sampleLimit: 200,
    sampleCapped: false,
    firstCompletedAt: at(0),
    lastCompletedAt: at(0),
    shownHands: 0,
    streets: { preflop: street, flop: street, turn: street, river: street },
    showdowns: [],
    recentEncountersWithHero: [],
    caveats: ['One observed hand, not a stable range.'],
  };
}

describe('independent knowledge boundary review', () => {
  it('recovers an eligible older publication when the worker cache already contains a later version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-knowledge-review-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const derivedPath = join(dir, 'derived.sqlite');
    const derived = new KnowledgeStore(derivedPath);
    derived.publish(snapshot(1, at(1)));
    derived.publish(snapshot(2, at(3)));
    derived.close();
    const service = new SlowLoopService(join(dir, 'raw-not-opened.sqlite'), derivedPath, {
      enabled: false,
    });
    cleanup.push(() => service.stop());
    await service.start();
    expect(service.latest().version).toBe('review-v2');
    const { store, state } = setup();
    store.knowledgeSource = service;
    const binding = store.pinKnowledge(state, at(5));
    expect(binding.pin.admissibleAt).toBe(at(2));
    expect(binding.pin.knowledgeVersion).toBe('review-v1');
    expect(binding.snapshot.publishedAt).toBe(at(1));
    expect(binding.pin.reason).toBe('published');
  });

  it('keeps a fixed publication usable after opponent identities arrive later in the same hand', async () => {
    const { store, state } = setup();
    const oldMemory = memory('late-visible-name');
    const latest = vi.fn(() => snapshot(1, at(1), [oldMemory]));
    store.knowledgeSource = source(latest);
    const initial = store.pinKnowledge(state, at(4));
    expect(initial.snapshot.opponents).toEqual([oldMemory]);
    expect(initial.pin.opponentMemory).toEqual([]);
    state.seats.push({ seat: 1, name: 'late-visible-name', stack: 100, bet: 0, status: 'active' });
    latest.mockImplementation(() => snapshot(2, at(3), []));
    const result = await decide(
      {
        key: authorityKey(state),
        state,
        controller: new AbortController(),
        deadlineAt: Date.now() + 5000,
        recovered: false,
        opponents: [],
        requireJev: true,
      },
      {
        store,
        apiKey: 'not-used',
        policy: {
          decide: async (context, candidates) => {
            expect(context.opponentMemory).toEqual([oldMemory]);
            expect(context.knowledge?.pin.knowledgeVersion).toBe('review-v1');
            return {
              candidateId: candidates[0]!.id,
              selected: candidates[0]!.id,
              explanation: 'Synthetic Jev result for knowledge boundary verification.',
              source: 'jev',
              latencyMs: 1,
              costUsd: 0,
            };
          },
        },
      },
      'run',
      1000,
    );
    expect(result?.action?.payload.action).toBe('check');
    expect(result?.decision.context.knowledge?.pin.knowledgeVersion).toBe('review-v1');
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('records baseline knowledge when the derived knowledge source throws, without blocking a Jev choice', async () => {
    const { store, state } = setup();
    store.knowledgeSource = source(() => {
      throw new Error('derived sqlite unavailable');
    });
    const result = await decide(
      {
        key: authorityKey(state),
        state,
        controller: new AbortController(),
        deadlineAt: Date.now() + 5000,
        recovered: false,
        opponents: [],
        requireJev: true,
      },
      {
        store,
        apiKey: 'not-used',
        policy: {
          decide: async (_context, candidates) => ({
            candidateId: candidates[0]!.id,
            selected: candidates[0]!.id,
            explanation: 'Synthetic Jev result for knowledge boundary verification.',
            source: 'jev',
            latencyMs: 1,
            costUsd: 0,
          }),
        },
      },
      'run',
      1000,
    );
    expect(result?.decision.context.knowledge?.pin.reason).toBe('baseline');
    expect(result?.decision.proposal.source).toBe('jev');
    expect(result?.action?.payload.action).toBe('check');
  });
});
