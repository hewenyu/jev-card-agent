import type { ResearchScheduleView } from '../../../src/shared/research';
import { number, time } from '../api';
import { Status } from './UI';

const reasons: Record<string, string> = {
  initial_sample: 'Building the first sample',
  refresh_threshold: 'Waiting for new hands',
  event_trigger: 'A completed hand triggered an early review',
  unchanged_evidence: 'No new evidence since the previous task',
  insufficient_waiting_new_evidence: 'Previous review needed more evidence',
  failed_waiting_new_evidence: 'Previous task failed; waiting for new evidence',
  queue_capacity: 'Waiting for a queue slot',
  pending_evidence_preserved: 'Queued trigger evidence will be reviewed before newer cases',
};
const triggers: Record<string, string> = {
  large_investment: 'Large investment',
  large_swing: 'Large settled result',
  showdown: 'Significant public showdown',
};
export function ResearchSchedule({
  schedules,
  mode,
}: {
  schedules?: ResearchScheduleView[];
  mode: 'off' | 'shadow' | 'live';
}) {
  if (!schedules) return null;
  return (
    <section aria-label="Research trigger progress" className="research-schedule">
      <h4>Next research</h4>
      {mode === 'off' && (
        <p className="annotation">Research is paused. Progress reflects the last scan.</p>
      )}
      {!schedules.length && (
        <p className="annotation">Waiting for eligible completed-hand evidence.</p>
      )}
      <div className="research-schedule-grid">
        {schedules.map((item) => {
          const remaining = Math.max(0, item.requiredHands - item.newHands);
          return (
            <article
              className="research-scope"
              key={`${item.taskType}:${item.scopeKey}`}
              aria-label={`${item.label} research progress`}
            >
              <div className="research-scope-heading">
                <strong>{item.label}</strong>
                <Status>{item.state}</Status>
              </div>
              <p className="annotation">
                {item.stage === 'initial' ? 'First brief' : 'Evidence refresh'} ·{' '}
                {number(item.windowHands)} evidence hands
              </p>
              <p className="research-progress-count">
                {number(item.newHands)} / {number(item.requiredHands)} new hands
                {item.state === 'waiting' && !item.triggerKind && remaining > 0 && (
                  <> · {number(remaining)} more needed</>
                )}
              </p>
              <progress
                value={Math.min(item.newHands, item.requiredHands)}
                max={Math.max(1, item.requiredHands)}
                aria-label={`${item.label} new evidence`}
              />
              <p className="annotation">
                {reasons[item.reason] ?? 'Checking research eligibility'}
                {item.triggerKind && <> · {triggers[item.triggerKind]}</>}
              </p>
              <p className="annotation">
                Last request {item.lastAttemptAt ? time(item.lastAttemptAt) : 'not yet made'}
                {item.lastOutcome && (
                  <>
                    {' '}
                    ·{' '}
                    {item.lastOutcome === 'insufficient'
                      ? 'more evidence needed'
                      : item.lastOutcome}
                  </>
                )}
              </p>
              <p className="annotation">Checked {time(item.updatedAt)}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
