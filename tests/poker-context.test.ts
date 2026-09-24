import { describe, expect, it } from 'vitest';
import { buildQuestions, evaluateAnswers, FixtureDecisionModel } from 'duelloop';
import { buildContext } from '../src/core/context.js';
import { buildSession, type SessionTurn } from '../src/core/session.js';
import { buildPokerContext } from '../src/poker/context.js';
import { buildPokerInput } from '../src/poker/input.js';
import { createPokerDomain } from '../src/poker/domain.js';
import { createPokerStrategy } from '../src/poker/strategy.js';
import { buildCandidates } from '../src/core/candidates.js';
import { pokerState } from './helpers/duelloop-fixture.js';

const identity = {
  scopeId: 'scope',
  actorId: 'hero',
  streamId: 'stream',
  trajectoryId: 'hand',
  revision: 'revision',
  observedAt: 1,
  authorityDeadline: 1000,
  factsSnapshotDigest: 'facts',
};
function turn(index: number, street: SessionTurn['street'], amount?: number): SessionTurn {
  return {
    decisionId: `earlier-${index}`,
    createdAt: '2026-09-24T00:00:00.000Z',
    tableSeq: index,
    street,
    status: 'accepted',
    source: 'jev',
    fallbackReason: null,
    action: amount === undefined ? { kind: 'check' } : { kind: 'raise', raiseToChips: amount },
    analysis: null,
    analysisTruncated: false,
  };
}

describe('shared live and evaluator behavioral context', () => {
  it.each([
    { name: 'first decision', street: 'flop' as const, earlier: [] },
    {
      name: 'second decision on the same street',
      street: 'flop' as const,
      earlier: [turn(1, 'flop')],
    },
    { name: 'street transition', street: 'turn' as const, earlier: [turn(1, 'flop')] },
    {
      name: 'multiple raises',
      street: 'turn' as const,
      earlier: [turn(1, 'flop', 40), turn(2, 'flop', 160), turn(3, 'turn', 200)],
    },
  ])('preserves the existing live projection for $name', async ({ street, earlier }) => {
    const state = pokerState();
    state.street = street;
    if (street === 'turn') state.board.push('9s');
    // This is the pre-refactor live construction, kept as an independent regression oracle.
    const live = buildContext(state, []);
    live.opponentMemory = [];
    live.session = buildSession(state.tableId!, state.handId!, 'old-live-id', earlier);
    const simulated = buildPokerContext(state, { previousTurns: earlier });
    const candidates = buildCandidates(state);
    const a = buildPokerInput(live, candidates, identity);
    const b = buildPokerInput(simulated, candidates, identity);
    expect(b.observation.features).toEqual(a.observation.features);
    expect(b.candidates).toEqual(a.candidates);
    expect(b.observation.features.poker).toMatchObject({
      session: {
        turn: earlier.length + 1,
        previousChoices: earlier.map(({ street, action, source, status }) => ({
          street,
          action,
          source,
          status,
        })),
      },
    });
    const domain = createPokerDomain({
      observe: async () => a.observation,
      candidates: async () => a.candidates,
    });
    const strategy = createPokerStrategy();
    const score = async (value: typeof a) => {
      const request = buildQuestions(strategy, value.observation, value.candidates, domain);
      const session = (request.state.features as { poker: { session: { turn: number } } }).poker
        .session;
      const preferred = session.turn % 2 ? 'check' : 'fold';
      const model = new FixtureDecisionModel('session-sensitive', (question) => ({
        score: question.actionId === preferred ? 4 : 0,
        confidence: 1,
        probabilities: Object.fromEntries(
          question.criteria.map((_, i) => [
            String(i),
            Number(i === (question.actionId === preferred ? 4 : 0)),
          ]),
        ),
      }));
      const answer = await model.score({ ...request, signal: new AbortController().signal });
      return evaluateAnswers(strategy, value.observation, value.candidates, answer.answers).action
        .id;
    };
    expect(await score(b)).toBe(await score(a));
    expect(await score(b)).toBe((earlier.length + 1) % 2 ? 'check' : 'fold');
  });

  it('retains failed/cancelled status semantics and isolates the supplied history', () => {
    const previous = [
      turn(1, 'flop'),
      { ...turn(2, 'flop'), status: 'cancelled', action: null },
      { ...turn(3, 'flop'), status: 'failed', action: null },
    ];
    const before = structuredClone(previous);
    const context = buildPokerContext(pokerState(), { previousTurns: previous });
    const projected = buildPokerInput(context, buildCandidates(pokerState()), identity);
    expect(projected.observation.features.poker).toMatchObject({
      session: {
        turn: 4,
        previousChoices: [
          { status: 'accepted', action: { kind: 'check' } },
          { status: 'cancelled', action: null },
          { status: 'failed', action: null },
        ],
      },
    });
    context.session!.previousTurns[0]!.action!.kind = 'fold';
    expect(previous).toEqual(before);
  });
});
