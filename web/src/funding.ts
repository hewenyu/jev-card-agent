import type { FundingView } from '../../src/shared/api';

/** Funding has its own freshness clock; table snapshots keep their existing SSE priority. */
export function latestFunding(
  overview: FundingView | undefined,
  streamed: FundingView | undefined,
  streamArrivedAfterRequest: boolean,
): FundingView | undefined {
  if (!overview) return streamed;
  if (!streamed) return overview;
  const overviewTime = Date.parse(overview.observedAt);
  const streamTime = Date.parse(streamed.observedAt);
  if (Number.isFinite(overviewTime) && Number.isFinite(streamTime) && overviewTime !== streamTime)
    return streamTime > overviewTime ? streamed : overview;
  return streamArrivedAfterRequest ? streamed : overview;
}
