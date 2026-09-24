import { describe, expect, it, vi } from 'vitest';
import { FixtureDecisionModel } from 'duelloop';
import { LiveDecisionCoordinator } from '../src/duelloop/live/coordinator.js';
import { Store } from '../src/storage/store.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { buildCandidates } from '../src/core/candidates.js';
import { buildContext } from '../src/core/context.js';
import type { SessionTurn } from '../src/core/session.js';
import { buildPokerContext } from '../src/poker/context.js';
import { buildPokerInput } from '../src/poker/input.js';
import { authorityKey, decisionStateKey } from '../src/runtime/authority.js';
import { pokerState } from './helpers/duelloop-fixture.js';

describe('live coordinator session contract', () => {
  it('projects durable earlier choices exactly like an independent simulated branch', async () => {
    const state = pokerState();
    state.street = 'turn';
    state.board.push('9s');
    const raw = new Store(':memory:');
    raw.acquireLease();
    raw.beginRun({
      id: 'run',
      kind: 'demo',
      strategy: 'jev',
      startedAt: new Date().toISOString(),
      config: {},
    });
    const previousTurns: SessionTurn[] = [];
    for (const [index, street, amount] of [
      [1, 'flop', 40],
      [2, 'flop', 100],
      [3, 'turn', 160],
    ] as const) {
      const previousState = { ...state, street, lastTableSeq: index };
      const id = `previous-${index}`;
      const candidate = {
        id: `raise_to_${amount}`,
        action: 'raise' as const,
        amount,
        label: 'Raise',
      };
      raw.saveDecision({
        id,
        runId: 'run',
        handId: state.handId!,
        createdAt: '2026-09-01T00:00:00.000Z',
        context: buildContext(previousState),
        candidates: [candidate],
        proposal: {
          candidateId: candidate.id,
          selected: candidate.id,
          source: 'jev',
          explanation: 'Fixture',
          latencyMs: 1,
        },
        fallbackReason: null,
      });
      raw.db.prepare("UPDATE decisions SET status='accepted' WHERE id=?").run(id);
      previousTurns.push({
        decisionId: id,
        createdAt: '2026-09-01T00:00:00.000Z',
        tableSeq: index,
        street,
        status: 'accepted',
        source: 'jev',
        fallbackReason: null,
        action: { kind: 'raise', raiseToChips: amount },
        analysis: null,
        analysisTruncated: false,
      });
    }
    const model = new FixtureDecisionModel('session-live', (question) => ({
      score: question.actionId === 'check' ? 4 : 0,
      confidence: 1,
      probabilities: Object.fromEntries(
        question.criteria.map((_, i) => [
          String(i),
          Number(i === (question.actionId === 'check' ? 4 : 0)),
        ]),
      ),
    }));
    const score = vi.spyOn(model, 'score');
    const coordinator = new LiveDecisionCoordinator({
      raw,
      databasePath: ':memory:',
      scopeId: 'session-test',
      actorId: 'hero',
      model,
      facts: baselineSnapshot,
      state: () => state,
      mode: 'simulation',
    });
    try {
      const now = Date.now();
      const result = await coordinator.decide(
        {
          key: authorityKey(state),
          stateKey: decisionStateKey(state),
          state,
          controller: new AbortController(),
          receivedAt: now,
          decisionDeadlineAt: now + 8000,
          deadlineAt: now + 10000,
          recovered: false,
          opponents: [],
        },
        'run',
        8000,
      );
      expect(result?.action?.payload.action).toBe('check');
      expect(score).toHaveBeenCalledTimes(1);
      const livePoker = (score.mock.calls[0]![0].state.features as { poker: unknown }).poker;
      const independent = buildPokerInput(
        buildPokerContext(state, { previousTurns }),
        buildCandidates(state),
        {
          scopeId: 'simulation',
          actorId: 'hero',
          streamId: 'simulation',
          trajectoryId: state.handId!,
          revision: 'simulation',
          observedAt: now,
          authorityDeadline: now + 10000,
          factsSnapshotDigest: 'simulation',
        },
      );
      expect(livePoker).toEqual(independent.observation.features.poker);
      expect(livePoker).toMatchObject({
        session: {
          turn: 4,
          previousChoices: previousTurns.map(({ street, action, source, status }) => ({
            street,
            action,
            source,
            status,
          })),
        },
      });
    } finally {
      await coordinator.close();
      raw.close();
    }
  });
});
