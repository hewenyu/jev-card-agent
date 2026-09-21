import type { DecisionView } from '../../../src/shared/api';
import { dollars, number, time } from '../api';
import { Status } from './UI';

export function Decision({ decision }: { decision: DecisionView }) {
  const selected = decision.candidates.find((item) => item.id === decision.selectedCandidateId);
  const routeLabels: Record<string, string> = {
    skipped_by_jev: 'Jev kept the direct choice',
    reconsidered: 'Reasoning consulted · Jev reconsidered',
    insufficient_time: 'Initial Jev choice retained · time limit',
    insufficient_time_after_analysis: 'Initial Jev choice retained · reconsideration time limit',
    analysis_or_reconsider_failed: 'Initial Jev choice retained · provider failure',
  };
  const outcome = typeof decision.routing?.outcome === 'string' ? decision.routing.outcome : null;
  return (
    <div className="decision-detail">
      <div className="decision-heading">
        <div>
          <p className="eyebrow">
            {decision.street} · {decision.source}
          </p>
          <h3>{selected?.label ?? 'No action selected'}</h3>
        </div>
        <Status>{decision.status}</Status>
      </div>
      <p className="subtle">
        {time(decision.createdAt)} · {decision.model ?? 'Rule-based policy'}
      </p>
      <div className="candidate-list">
        {decision.candidates.map((candidate) => {
          const probability = decision.probabilities[candidate.id];
          const chosen = candidate.id === decision.selectedCandidateId;
          return (
            <div className={`candidate ${chosen ? 'chosen' : ''}`} key={candidate.id}>
              <div className="candidate-label">
                <span>
                  {candidate.label}
                  {chosen && <small>SELECTED</small>}
                </span>
                <strong>
                  {probability === undefined
                    ? '—'
                    : `${(Math.max(0, Math.min(1, probability)) * 100).toFixed(1)}%`}
                </strong>
              </div>
              <div className="probability-track">
                <span style={{ width: `${Math.max(0, Math.min(1, probability ?? 0)) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="annotation">
        Choice probabilities describe the model’s selection, not the probability of winning the
        hand.
      </p>
      <div className="decision-stats">
        <div>
          <span>Response</span>
          <strong>{number(decision.latencyMs)} ms</strong>
        </div>
        <div>
          <span>Estimated cost</span>
          <strong>{dollars(decision.costUsd)}</strong>
        </div>
        <div>
          <span>Confidence</span>
          <strong>{decision.confidence === null ? '—' : decision.confidence.toFixed(3)}</strong>
        </div>
      </div>
      {decision.fallbackReason && (
        <div className="warning-notice">Fallback: {decision.fallbackReason}</div>
      )}
      {outcome || decision.attempts?.length ? (
        <section className="provider-trace" aria-label="Provider trace">
          <p className="eyebrow">DECISION ROUTE</p>
          {outcome && <h4>{routeLabels[outcome] ?? outcome.replaceAll('_', ' ')}</h4>}
          {decision.attempts?.map((attempt, index) => (
            <div className="provider-attempt" key={`${attempt.provider}-${index}`}>
              <span className="attempt-number">{index + 1}</span>
              <div>
                <strong>
                  {attempt.provider} · {attempt.actualModel ?? 'Model not reported'}
                </strong>
                <small>
                  Requested: {attempt.requestedModel} · {number(attempt.latencyMs)} ms
                </small>
              </div>
              <Status>{attempt.status.replaceAll('_', ' ')}</Status>
            </div>
          ))}
          {decision.routing && (
            <details className="routing-details">
              <summary>Inspect routing record</summary>
              <pre>{JSON.stringify(decision.routing, null, 2)}</pre>
            </details>
          )}
        </section>
      ) : null}
      <details className="context-details">
        <summary>Inspect decision context</summary>
        <p className="annotation">Information available at this decision’s cutoff.</p>
        <pre>{JSON.stringify(decision.context, null, 2)}</pre>
      </details>
    </div>
  );
}
