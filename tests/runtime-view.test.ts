import { describe, expect, it } from 'vitest';
import type { RuntimeView } from '../src/shared/api';
import { latestRuntime } from '../web/src/runtime-view';

function runtime(sequence: number | undefined, stack = 1000): RuntimeView {
  return {
    running: true,
    status: 'playing',
    mode: 'live',
    runId: 'run',
    strategy: 'jev',
    error: null,
    table: {
      tableId: 'table',
      handId: 'hand',
      street: 'preflop',
      pot: 30,
      board: [],
      heroCards: ['Ah', 'Kd'],
      heroSeat: 0,
      dealerSeat: 1,
      stateSeq: sequence,
      seats: [{ seat: 0, name: 'Hero', stack, bet: 20, folded: false, status: 'active' }],
    },
  };
}

describe('Live runtime freshness across polling and SSE', () => {
  it('uses polling while a connected stream retains an older table', () => {
    const overview = runtime(12, 980);
    const streamed = runtime(10);
    expect(latestRuntime(overview, streamed, false)).toBe(overview);
  });

  it('ignores a late SSE snapshot with an older table sequence', () => {
    const overview = runtime(12, 980);
    expect(latestRuntime(overview, runtime(11), true)).toBe(overview);
  });

  it('does not let a delayed HTTP response roll back a newer stream', () => {
    const streamed = runtime(14, 960);
    expect(latestRuntime(runtime(12), streamed, true)).toBe(streamed);
    expect(latestRuntime(runtime(12), streamed, false)).toBe(streamed);
  });

  it.each([true, false])('uses request-relative arrival on equal sequences: %s', (after) => {
    const overview = runtime(12);
    const streamed = { ...runtime(12), status: 'stopping' };
    expect(latestRuntime(overview, streamed, after)).toBe(after ? streamed : overview);
  });

  it.each(['run', 'table', 'no-table'])(
    'does not compare sequence numbers across different scopes: %s',
    (scope) => {
      const overview = runtime(2);
      const streamed = runtime(99);
      if (scope === 'run') streamed.runId = 'older-run';
      if (scope === 'table') streamed.table!.tableId = 'older-table';
      if (scope === 'no-table') overview.table = null;
      expect(latestRuntime(overview, streamed, false)).toBe(overview);
      expect(latestRuntime(overview, streamed, true)).toBe(streamed);
    },
  );

  it.each([undefined, -1, NaN, Infinity, 1.5])(
    'uses request-relative arrival without a valid sequence: %s',
    (sequence) => {
      const overview = runtime(sequence);
      const streamed = runtime(10);
      expect(latestRuntime(overview, streamed, false)).toBe(overview);
      expect(latestRuntime(overview, streamed, true)).toBe(streamed);
    },
  );

  it('uses the overview before the first stream snapshot arrives', () => {
    const overview = runtime(2);
    expect(latestRuntime(overview, undefined, true)).toBe(overview);
  });
});
