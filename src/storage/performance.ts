import type { PerformanceView } from '../shared/api.js';
import type { Store } from './store.js';

const MAX_POINTS = 500;

function sampleIndices(count: number): Set<number> {
  const size = Math.min(count, MAX_POINTS);
  return new Set(
    Array.from({ length: size }, (_, index) =>
      size <= 1 ? 0 : Math.round((index * (count - 1)) / (size - 1)),
    ),
  );
}

/** Read complete Run history without applying the list endpoints' pagination limits. */
export function runPerformance(store: Pick<Store, 'db'>, runId: string): PerformanceView | null {
  const { db } = store;
  if (!db.prepare('SELECT id FROM runs WHERE id=?').get(runId)) return null;
  const counts = db
    .prepare(
      `SELECT
        COUNT(CASE WHEN complete=1 AND profit IS NOT NULL THEN 1 END) AS settled,
        COUNT(CASE WHEN complete=1 AND profit>0 THEN 1 END) AS won,
        COUNT(CASE WHEN complete<>1 OR profit IS NULL THEN 1 END) AS excluded
       FROM hands WHERE run_id=? AND status='complete'`,
    )
    .get(runId)!;
  const settledHands = Number(counts.settled);
  const wonHands = Number(counts.won);
  const profitIndices = sampleIndices(settledHands);
  const profitPoints: PerformanceView['profitPoints'] = [];
  let netChips = 0;
  let handIndex = 0;
  for (const row of db
    .prepare(
      `SELECT hand_number,profit,COALESCE(ended_at,started_at) AS at FROM hands
       WHERE run_id=? AND status='complete' AND complete=1 AND profit IS NOT NULL
       ORDER BY COALESCE(ended_at,started_at),id`,
    )
    .iterate(runId)) {
    netChips += Number(row.profit);
    if (profitIndices.has(handIndex))
      profitPoints.push({
        at: String(row.at),
        handNumber: Number(row.hand_number),
        settledHands: handIndex + 1,
        netChips,
      });
    handIndex += 1;
  }

  // New records retain the official score independently of both chip balances.
  // Old sums remain explicitly labelled estimates; never backfill them as official observations.
  const baseFilter = `run_id=? AND kind='balance_sync' AND source IN ('rest','reconciliation')`;
  const latestOfficialObservation = db
    .prepare(
      `SELECT season_id FROM funding_events WHERE ${baseFilter} AND score_source IS NOT NULL
       ORDER BY created_at DESC,rowid DESC LIMIT 1`,
    )
    .get(runId);
  const seasonId =
    latestOfficialObservation?.season_id == null
      ? null
      : String(latestOfficialObservation.season_id);
  const scoreFilter = latestOfficialObservation
    ? `${baseFilter} AND score_source IS NOT NULL AND season_id IS ?`
    : `${baseFilter} AND available_after IS NOT NULL AND chips_at_table IS NOT NULL`;
  const parameters = latestOfficialObservation ? [runId, seasonId] : [runId];
  const scoreCount = Number(
    db
      .prepare(`SELECT COUNT(*) AS count FROM funding_events WHERE ${scoreFilter}`)
      .get(...parameters)!.count,
  );
  const scoreIndices = sampleIndices(scoreCount);
  const scorePoints: PerformanceView['scorePoints'] = [];
  let score: number | null = null;
  let scoreObservedAt: string | null = null;
  let scoreSource: PerformanceView['scoreSource'] = null;
  let scoreIndex = 0;
  for (const row of db
    .prepare(
      `SELECT created_at,available_after,chips_at_table,season_score,score_source FROM funding_events
       WHERE ${scoreFilter} ORDER BY created_at,${latestOfficialObservation ? 'rowid' : 'id'}`,
    )
    .iterate(...parameters)) {
    score = latestOfficialObservation
      ? row.season_score == null
        ? null
        : Number(row.season_score)
      : Number(row.available_after) + Number(row.chips_at_table);
    scoreSource =
      score === null ? null : latestOfficialObservation ? 'official' : 'legacy_balance_sum';
    scoreObservedAt = String(row.created_at);
    if (score !== null && scoreIndices.has(scoreIndex))
      scorePoints.push({ at: scoreObservedAt, score });
    scoreIndex += 1;
  }
  return {
    runId,
    settledHands,
    wonHands,
    excludedHands: Number(counts.excluded),
    netChips,
    winRate: settledHands === 0 ? null : (wonHands / settledHands) * 100,
    score,
    scoreObservedAt,
    scoreSource,
    seasonId,
    profitPoints,
    scorePoints,
  };
}
