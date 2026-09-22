import type { DatabaseSync } from 'node:sqlite';
import type { ResearchActivity, ResearchActivityCounts } from '../shared/research.js';

export interface DecisionCounts {
  evaluated: number;
  adopted: number;
  unmatched: number;
}
export const emptyDecisionCounts = (): DecisionCounts => ({
  evaluated: 0,
  adopted: 0,
  unmatched: 0,
});
type LedgerCounts = Omit<
  ResearchActivityCounts,
  'evaluatedDecisions' | 'adoptedDecisions' | 'unmatchedDecisions'
>;
interface RunWindow {
  id: string;
  startedAt: string;
  endedAt: string | null;
}
function counts(research: DatabaseSync | null, run: RunWindow | null): LedgerCounts {
  const window = run ? [run.startedAt, run.endedAt ?? '9999-12-31T23:59:59.999Z'] : [];
  const attempts = research
    ?.prepare(
      `SELECT COUNT(*) AS attempts,
       COALESCE(SUM(status='succeeded'),0) AS succeeded,
       COALESCE(SUM(status NOT IN ('started','succeeded')),0) AS failed,
       COALESCE(SUM(COALESCE(json_extract(attempt,'$.retryIndex'),0)>0),0) AS retries
       FROM research_attempts ${run ? 'WHERE started_at>=? AND started_at<=?' : ''}`,
    )
    .get(...window);
  const jobs = research
    ?.prepare(
      `SELECT COUNT(*) AS completed,
       COALESCE(SUM(json_extract(outcome,'$.insufficient')=1),0) AS insufficient
       FROM research_jobs WHERE state='completed'
       ${run ? 'AND completed_at>=? AND completed_at<=?' : ''}`,
    )
    .get(...window);
  return {
    attempts: Number(attempts?.attempts ?? 0),
    successfulAttempts: Number(attempts?.succeeded ?? 0),
    failedAttempts: Number(attempts?.failed ?? 0),
    retries: Number(attempts?.retries ?? 0),
    completedJobs: Number(jobs?.completed ?? 0),
    insufficientJobs: Number(jobs?.insufficient ?? 0),
  };
}
/** Per-monitor cache: expensive all-history aggregates refresh at most once per 15 seconds.
 * Run identity/boundary changes and a newly opened reader bypass the cache immediately.
 * Immutable decisions have their own incremental cursor and are never cached here.
 */
export class ResearchActivityCounter {
  private cached?: {
    research: DatabaseSync | null;
    runKey: string;
    at: number;
    allTime: LedgerCounts;
    currentRun: LedgerCounts | null;
  };
  constructor(private readonly now: () => number = Date.now) {}
  read(research: DatabaseSync | null, run: RunWindow | null) {
    const at = this.now();
    const runKey = JSON.stringify(run);
    if (
      !this.cached ||
      this.cached.research !== research ||
      this.cached.runKey !== runKey ||
      at < this.cached.at ||
      at - this.cached.at >= 15000
    )
      this.cached = {
        research,
        runKey,
        at,
        allTime: counts(research, null),
        currentRun: run ? counts(research, run) : null,
      };
    return this.cached;
  }
}
function decisionCounts(value: DecisionCounts) {
  return {
    evaluatedDecisions: value.evaluated,
    adoptedDecisions: value.adopted,
    unmatchedDecisions: value.unmatched,
  };
}
/** Time windows describe call activity, not ownership of the historical evidence in a batch. */
export function researchActivity(
  raw: DatabaseSync,
  research: DatabaseSync | null,
  all: DecisionCounts,
  byRun: ReadonlyMap<string, DecisionCounts>,
  caughtUp: boolean,
  counter = new ResearchActivityCounter(),
): ResearchActivity {
  const row = raw
    .prepare(
      "SELECT id,started_at,ended_at FROM runs WHERE mode='live' ORDER BY started_at DESC,rowid DESC LIMIT 1",
    )
    .get();
  const run: RunWindow | null = row
    ? {
        id: String(row.id),
        startedAt: String(row.started_at),
        endedAt: row.ended_at === null ? null : String(row.ended_at),
      }
    : null;
  const ledger = counter.read(research, run);
  return {
    allTime: { ...ledger.allTime, ...decisionCounts(all) },
    currentRun:
      run && ledger.currentRun
        ? {
            ...run,
            ...ledger.currentRun,
            ...decisionCounts(byRun.get(run.id) ?? emptyDecisionCounts()),
          }
        : null,
    decisionsCaughtUp: caughtUp,
  };
}
