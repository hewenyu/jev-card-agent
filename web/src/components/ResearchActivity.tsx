import type {
  ResearchActivity as Activity,
  ResearchActivityCounts,
} from '../../../src/shared/research';
import { number, time } from '../api';

function Counts({ value }: { value: ResearchActivityCounts }) {
  return (
    <dl className="fast-slow-facts research-activity-counts">
      <div>
        <dt>API attempts / retries</dt>
        <dd>
          {number(value.attempts)} / {number(value.retries)}
        </dd>
      </div>
      <div>
        <dt>Successful / failed attempts</dt>
        <dd>
          {number(value.successfulAttempts)} / {number(value.failedAttempts)}
        </dd>
      </div>
      <div>
        <dt>Completed / insufficient-evidence tasks</dt>
        <dd>
          {number(value.completedJobs)} / {number(value.insufficientJobs)}
        </dd>
      </div>
      <div>
        <dt>Actual advice adoption</dt>
        <dd>
          {number(value.adoptedDecisions)} / {number(value.evaluatedDecisions)} live decisions
          {value.evaluatedDecisions > 0 && (
            <> · {Math.round((value.adoptedDecisions / value.evaluatedDecisions) * 100)}%</>
          )}
        </dd>
      </div>
    </dl>
  );
}
export function ResearchActivity({ activity }: { activity?: Activity }) {
  if (!activity) return null;
  return (
    <div className="research-activity-grid">
      <section aria-label="Research activity in latest run" className="research-activity-card">
        <h4>Latest live run</h4>
        {activity.currentRun ? (
          <>
            <p className="annotation">
              Since {time(activity.currentRun.startedAt)}
              {activity.currentRun.endedAt && <> · Ended {time(activity.currentRun.endedAt)}</>}
            </p>
            <Counts value={activity.currentRun} />
          </>
        ) : (
          <p className="annotation">No live run recorded.</p>
        )}
      </section>
      <section aria-label="Research activity across all history" className="research-activity-card">
        <h4>All history</h4>
        <p className="annotation">Includes diagnostics and earlier runs.</p>
        <Counts value={activity.allTime} />
      </section>
      <p className="annotation research-activity-note">
        Attempts include retries. An insufficient-evidence result completes a task without proposing
        advice. Run activity uses its time window; research can draw on earlier hands. Adoption
        counts only decisions made in live research mode. Call totals refresh within fifteen
        seconds.
        {!activity.decisionsCaughtUp && ' Historical decision counts are still loading.'}
      </p>
    </div>
  );
}
