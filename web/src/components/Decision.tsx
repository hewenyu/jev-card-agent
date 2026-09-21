import type { DecisionView } from '../../../src/shared/api';
import { dollars, number, time } from '../api';
import { Status } from './UI';
import { DecisionAnalysis } from './DecisionAnalysis';

export function Decision({ decision }: { decision: DecisionView }) {
  const selected = decision.candidates.find((item) => item.id === decision.selectedCandidateId);
  const cancelled = decision.status === 'cancelled';
  const failed = decision.status === 'failed' || decision.source === 'unavailable';
  return (
    <div className="decision-detail">
      <div className="decision-heading">
        <div>
          <p className="eyebrow">
            {decision.street} · {decision.source}
          </p>
          <h3>
            {failed
              ? 'Model decision failed · no action submitted'
              : cancelled
                ? 'Cancelled · no action submitted'
                : (selected?.label ?? 'No action recorded')}
          </h3>
        </div>
        <Status>{decision.status}</Status>
      </div>
      <p className="subtle">
        {time(decision.createdAt)} ·{' '}
        {decision.model ?? (failed ? 'Model unavailable' : 'Rule-based policy')}
      </p>
      {decision.fallbackReason && (
        <div className="warning-notice">
          {failed ? 'Failure reason' : cancelled ? 'Cancellation reason' : 'Historical fallback'}:{' '}
          {decision.fallbackReason}
        </div>
      )}
      <DecisionAnalysis decision={decision} />
      <div className="candidate-list">
        {decision.candidates.map((candidate) => {
          const probability = decision.probabilities[candidate.id];
          const chosen = !cancelled && !failed && candidate.id === decision.selectedCandidateId;
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
      <details className="context-details">
        <summary>Inspect decision context</summary>
        <p className="annotation">Information available at this decision’s cutoff.</p>
        <pre>{JSON.stringify(decision.context, null, 2)}</pre>
      </details>
    </div>
  );
}
