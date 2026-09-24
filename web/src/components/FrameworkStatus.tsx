import type { FrameworkStatusView } from '../../../src/shared/framework';
import { Panel, Status } from './UI';
import './framework.css';

const short = (value: string | null) => (value ? value.slice(0, 12) : 'Not bound');
export function FrameworkStatus({
  framework,
}: {
  framework: FrameworkStatusView | null | undefined;
}) {
  if (!framework) return null;
  const r = framework.research;
  const label = !r.enabled
    ? 'Disabled'
    : r.paused
      ? 'Paused'
      : r.error
        ? 'Needs attention'
        : r.state;
  return (
    <Panel
      title="Strategy & research"
      eyebrow="DUELLOOP · JEV DECISIONS"
      action={<Status>{label}</Status>}
    >
      <dl className="framework-facts">
        <div>
          <dt>Active strategy release</dt>
          <dd title={framework.activeReleaseDigest ?? undefined}>
            {short(framework.activeReleaseDigest)}
          </dd>
        </div>
        <div>
          <dt>This hand’s release</dt>
          <dd title={framework.handReleaseDigest ?? undefined}>
            {short(framework.handReleaseDigest)}
          </dd>
        </div>
        <div>
          <dt>Frozen historical facts</dt>
          <dd title={framework.factsSnapshotDigest ?? undefined}>
            {short(framework.factsSnapshotDigest)}
          </dd>
        </div>
        <div>
          <dt>Unresolved executions</dt>
          <dd>{framework.unresolvedIntents}</dd>
        </div>
        <div>
          <dt>Background researcher</dt>
          <dd>{r.provider ?? 'Not started'}</dd>
        </div>
        <div>
          <dt>Activation</dt>
          <dd>
            {r.activationPaused
              ? 'Paused'
              : r.activationMode === 'explicit'
                ? 'Explicit operator approval'
                : r.activationMode}
          </dd>
        </div>
      </dl>
      <p className="annotation">
        Jev chooses each action. Background research evaluates strategy proposals independently. A
        new release applies to future hands; the current hand keeps its pinned release.
        Deterministic facts progress is shown separately.
      </p>
      {r.error && <p className="warning-notice">{r.error}</p>}
      {r.pendingReleases.length > 0 && (
        <div className="framework-pending">
          <h3>Validated proposals awaiting activation</h3>
          <ul>
            {r.pendingReleases.map((release) => (
              <li key={release.digest}>
                <code title={release.digest}>{short(release.digest)}</code>
                <span>Validation {short(release.validationDigest)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.recentRuns.length > 0 && (
        <div className="framework-table-scroll">
          <table className="framework-table">
            <caption>Recent strategy research</caption>
            <thead>
              <tr>
                <th>Run</th>
                <th>Result</th>
                <th>Research requests</th>
                <th>Evaluation calls</th>
                <th>Recorded tokens</th>
              </tr>
            </thead>
            <tbody>
              {r.recentRuns.slice(0, 8).map((run) => (
                <tr key={run.id}>
                  <td title={run.id}>{short(run.id)}</td>
                  <td>{run.status}</td>
                  <td title={`${run.modelCalls} SDK role invocations`}>{run.providerRequests}</td>
                  <td>{run.evaluationCalls}</td>
                  <td>{run.tokens ?? 'Unknown'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="annotation">
        {r.updatedAt ? `Updated ${new Date(r.updatedAt).toLocaleString()}. ` : ''}Inconclusive
        evaluation keeps the existing strategy. An engineering test or a small sample does not
        establish profitability.
      </p>
    </Panel>
  );
}
