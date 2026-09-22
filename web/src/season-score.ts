import type { FundingView, PerformanceView } from '../../src/shared/api';

export function fundingIsStale(funding: FundingView | undefined, now: number): boolean {
  const confirmed = funding?.updatedAt ? Date.parse(funding.updatedAt) : NaN;
  return funding?.status === 'stale' || (Number.isFinite(confirmed) && now - confirmed > 45_000);
}

/** Never join a legacy balance estimate or another season onto the current official score. */
export function currentScorePoints(data: PerformanceView | null, funding: FundingView | undefined) {
  const sameSeason =
    data?.scoreSource === 'official' && !!funding?.seasonId && data.seasonId === funding.seasonId;
  const at = funding?.updatedAt;
  const cutoff = at ? Date.parse(at) : NaN;
  const points = sameSeason
    ? data.scorePoints
        .filter((point) => !Number.isFinite(cutoff) || Date.parse(point.at) <= cutoff)
        .map((point) => ({ ...point }))
    : [];
  const score = funding?.seasonScore;
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    !at ||
    !Number.isFinite(Date.parse(at))
  )
    return points;
  const latest = points.at(-1);
  if (!latest || Date.parse(at) >= Date.parse(latest.at)) {
    if (latest?.at === at) points[points.length - 1] = { at, score };
    else points.push({ at, score });
  }
  return points;
}
