import { describe, expect, it } from 'vitest';
import {
  buildContext,
  createInitialState,
  STRATEGY_VERSIONS,
  summarizeRecentOutcomes,
  type HistoricalDecision,
  type HistoricalOutcome,
} from '../src/core/index.js';

const asOf = '2026-01-02T00:00:00.000Z';
function decision(index = 0): HistoricalDecision {
  return {
    decisionId: `decision-${index}`,
    decidedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    tableSeq: index,
    street: 'flop',
    board: ['2h', '3d', '4c'],
    holeCards: ['Ah', 'Kd'],
    action: 'check',
  };
}
function outcome(index = 0): HistoricalOutcome {
  return {
    runId: 'live-run',
    strategy: 'jev',
    handId: `hand-${index}`,
    tableId: 'table',
    completedAt: new Date(Date.UTC(2026, 0, 1, 1, index)).toISOString(),
    verified: true,
    profitBb: -1.5,
    decisions: [decision()],
  };
}

describe('bounded historical decision feedback', () => {
  it('excludes current, future, invalid and unverified results', () => {
    const source = [
      outcome(),
      { ...outcome(1), handId: 'current' },
      { ...outcome(2), verified: false },
      { ...outcome(3), completedAt: asOf },
      { ...outcome(4), completedAt: '2026-01-03T00:00:00.000Z' },
      { ...outcome(5), completedAt: 'invalid' },
      { ...outcome(6), profitBb: Number.NaN },
      { ...outcome(7), profitBb: Number.POSITIVE_INFINITY },
    ];
    const result = summarizeRecentOutcomes(source, asOf, 'current');
    expect(result.map((item) => item.handId)).toEqual(['hand-0']);
    expect(result[0]).not.toHaveProperty('verified');
    expect(summarizeRecentOutcomes(source, 'invalid', null)).toEqual([]);
  });

  it('retains each action-time board and removes decisions after completion', () => {
    const historical = outcome();
    historical.decisions = [
      decision(),
      { ...decision(1), street: 'turn', board: ['2h', '3d', '4c', '5s'] },
      { ...decision(2), decidedAt: asOf },
      { ...decision(3), decidedAt: '2026-01-01T02:00:00.000Z' },
      { ...decision(4), tableSeq: Number.NaN },
    ];
    const [summary] = summarizeRecentOutcomes([historical], asOf, null);
    expect(summary?.decisions.map((item) => item.board)).toEqual([
      ['2h', '3d', '4c'],
      ['2h', '3d', '4c', '5s'],
    ]);
    expect(summary?.profitBb).toBe(-1.5);
    historical.decisions[0]!.board.push('Qh');
    expect(summary?.decisions[0]?.board).toHaveLength(3);
  });

  it('takes the latest ten unique hands and latest eight unique actions in stable order', () => {
    const source = Array.from({ length: 15 }, (_, index) => outcome(index));
    const last = source[14]!;
    last.decisions = Array.from({ length: 12 }, (_, index) => decision(index));
    last.decisions.push(decision(11));
    source.push({ ...last, runId: 'z-recovered-run' });
    const result = summarizeRecentOutcomes(source, asOf, null);
    expect(result).toHaveLength(10);
    expect(result[0]?.handId).toBe('hand-14');
    expect(result[9]?.handId).toBe('hand-5');
    expect(result[0]?.decisions.map((item) => item.decisionId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `decision-${index + 4}`),
    );
    expect(result[0]?.decisionsTruncated).toBe(true);
    expect(result[1]?.decisionsTruncated).toBe(false);
    expect(summarizeRecentOutcomes([...source].reverse(), asOf, null)).toEqual(result);
  });

  it('freezes the information cutoff, strategy versions and feedback alongside current state', () => {
    const state = { ...createInitialState(), handId: 'current', lastTableSeq: 42 };
    const history = [outcome()];
    const context = buildContext(state, [], { asOf, recentOutcomes: history });
    expect(context.lastTableSeq).toBe(42);
    expect(context.asOf).toBe(asOf);
    expect(context.strategyVersions).toEqual(STRATEGY_VERSIONS);
    expect(context.version).toBe(STRATEGY_VERSIONS.context);
    expect(context.recentOutcomes[0]?.strategy).toBe('jev');
    history[0]!.profitBb = 999;
    state.lastTableSeq = 43;
    expect(context.strategyVersions).not.toBe(STRATEGY_VERSIONS);
    expect(context.recentOutcomes[0]?.profitBb).toBe(-1.5);
    expect(context.lastTableSeq).toBe(42);
    expect(STRATEGY_VERSIONS.prompt).toBe('poker-choice-v3');
    expect(buildContext(state).recentOutcomes).toEqual([]);
    expect(buildContext(state).asOf).toBeNull();
  });
});
