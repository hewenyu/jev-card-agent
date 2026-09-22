import type { DecisionView } from '../../../src/shared/api';
import { dollars, number, time } from '../api';
import { Status } from './UI';
import { DecisionAnalysis } from './DecisionAnalysis';
import { FastSlowEvidence } from './FastSlowEvidence';

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
      <FastSlowEvidence decision={decision} />
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
        <summary>Actual Jev input</summary>
        {decision.modelInput ? (
          <>
            <p className="annotation">
              Saved request state for this Jev response, with private fields removed. This is not
              reconstructed from the audit context.
            </p>
            <pre>{JSON.stringify(decision.modelInput, null, 2)}</pre>
          </>
        ) : (
          <p className="annotation">
            The actual Jev request state is not available in this record.
          </p>
        )}
      </details>
      {decision.modelQuestions && (
        <details className="context-details">
          <summary>Decision instructions and candidate costs</summary>
          <p className="annotation">
            Saved questions sent with this Jev request, including its instructions and candidate
            criteria.
          </p>
          <pre>{JSON.stringify(decision.modelQuestions, null, 2)}</pre>
        </details>
      )}
      <details className="context-details">
        <summary>Inspect decision context</summary>
        <p className="annotation">
          Information available at this decision’s cutoff. The record includes audit history;
          versions with a poker harness send a compact projection to Jev, excluding recent outcomes.
        </p>
        <pre>{JSON.stringify(decision.context, null, 2)}</pre>
      </details>
    </div>
  );
}
