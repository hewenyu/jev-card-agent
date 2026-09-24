import type { FrameworkDecisionView } from '../../../src/shared/framework';
import './framework.css';

export function FrameworkDecision({ framework }: { framework: FrameworkDecisionView | undefined }) {
  if (!framework) return null;
  const u = framework.usage;
  return (
    <section className="framework-decision" aria-label="Framework decision evidence">
      <h4>DuelLoop decision evidence</h4>
      <dl className="framework-facts">
        <div>
          <dt>Strategy release</dt>
          <dd title={framework.releaseDigest}>{framework.releaseDigest.slice(0, 12)}</dd>
        </div>
        <div>
          <dt>Selection rule</dt>
          <dd>{framework.selection}</dd>
        </div>
        <div>
          <dt>Historical facts</dt>
          <dd title={framework.factsSnapshotDigest ?? undefined}>
            {framework.factsSnapshotDigest?.slice(0, 12) ?? 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt>Token usage</dt>
          <dd>
            {u.inputTokens ?? 'Unknown'} in / {u.outputTokens ?? 'Unknown'} out
            {!u.tokensComplete ? ' · incomplete' : ''}
          </dd>
        </div>
        <div>
          <dt>Request cost</dt>
          <dd>
            {u.costComplete && u.costUsd !== null
              ? `$${u.costUsd.toFixed(6)}`
              : 'Unknown / incomplete'}
          </dd>
        </div>
        <div>
          <dt>Model deadline</dt>
          <dd>
            {framework.modelDeadline
              ? new Date(framework.modelDeadline).toLocaleTimeString()
              : 'Not recorded'}
          </dd>
        </div>
      </dl>
      <div className="framework-table-scroll">
        <table className="framework-table">
          <caption>Provider scores by candidate</caption>
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Dimension</th>
              <th>Score</th>
              <th>Provider confidence</th>
              <th>Combined utility</th>
            </tr>
          </thead>
          <tbody>
            {framework.scores.map((row) => (
              <tr key={`${row.dimensionId}:${row.candidateId}`}>
                <td>{row.candidateId}</td>
                <td>{row.dimensionId}</td>
                <td>
                  {row.score.toFixed(3)} / {row.levels - 1}
                </td>
                <td>
                  {row.confidence === null
                    ? 'Not reported'
                    : `${(row.confidence * 100).toFixed(1)}%`}
                </td>
                <td>{framework.utilities[row.candidateId]?.toFixed(3) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="annotation">
        Scores are ordinal assessments, not chip EV or poker win probabilities. Provider confidence
        describes its score distribution. Under argmax, a selected action’s 100% selection
        probability comes from the deterministic selection rule; it is not 100% model confidence.
      </p>
    </section>
  );
}
