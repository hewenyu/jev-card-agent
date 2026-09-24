import type { RuntimeView } from '../../../src/shared/api';
import { number } from '../api';
import { Panel, Status } from './UI';
import './fast-slow.css';

export function ResearchStatus({
  research,
  factsOnly = false,
}: {
  research: RuntimeView['research'];
  factsOnly?: boolean;
}) {
  if (!research) return null;
  const label = !research.enabled
    ? 'Disabled'
    : research.error
      ? 'Needs attention'
      : research.running
        ? 'Running'
        : 'Idle';
  return (
    <Panel
      title={factsOnly ? 'Historical facts' : 'Asynchronous knowledge'}
      eyebrow="DETERMINISTIC STATISTICS · NO RESEARCH LLM"
      action={<Status>{label}</Status>}
    >
      <div aria-label="Research worker status">
        <dl className="fast-slow-facts">
          <div>
            <dt>Worker</dt>
            <dd>{label}</dd>
          </div>
          <div>
            <dt>Pending completed hands</dt>
            <dd>{research.lastCompletedAt ? number(research.pendingHands) : 'Not measured yet'}</dd>
          </div>
          <div>
            <dt>Pending audits</dt>
            <dd>
              {research.lastCompletedAt ? number(research.pendingAudits) : 'Not measured yet'}
            </dd>
          </div>
          <div>
            <dt>{factsOnly ? 'Latest facts snapshot' : 'Latest published version'}</dt>
            <dd>{research.latestVersion || 'No publication yet'}</dd>
          </div>
          <div>
            <dt>Last completed batch</dt>
            <dd>{research.lastCompletedAt ?? 'No completed batch recorded'}</dd>
          </div>
        </dl>
        {research.error && (
          <p className="warning-notice">
            The knowledge worker is unavailable. The current hand retains its fixed knowledge.
          </p>
        )}
        <p className="annotation">
          Queue counts reflect the last completed batch. Jev does not wait for this worker. New
          eligible knowledge is selected for a new hand; audit results are added separately to
          decision history.
        </p>
      </div>
    </Panel>
  );
}
