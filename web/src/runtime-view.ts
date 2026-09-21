import type { RuntimeView } from '../../src/shared/api';

const validSequence = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Compare table authority before arrival time; an open SSE connection can still lag polling. */
export function latestRuntime(
  overview: RuntimeView,
  streamed: RuntimeView | undefined,
  streamArrivedAfterRequest: boolean,
): RuntimeView {
  if (!streamed) return overview;
  const overviewTable = overview.table;
  const streamedTable = streamed.table;
  if (
    overview.runId === streamed.runId &&
    overviewTable?.tableId &&
    overviewTable.tableId === streamedTable?.tableId &&
    validSequence(overviewTable.stateSeq) &&
    validSequence(streamedTable.stateSeq) &&
    overviewTable.stateSeq !== streamedTable.stateSeq
  )
    return streamedTable.stateSeq > overviewTable.stateSeq ? streamed : overview;
  return streamArrivedAfterRequest ? streamed : overview;
}
