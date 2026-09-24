import { JsonDetails } from './JsonDetails';
import type { DecisionView } from '../../../src/shared/api';
import { number } from '../api';
import { asRecord, finite, retryLabel, text } from './analysis-data';
import { DecisionEvidence } from './DecisionEvidence';
import { Status } from './UI';
import './decision-analysis.css';

const outcomes: Record<string, string> = {
  reasoned_jev_final: 'Reasoning completed · Jev made the final choice',
  analysis_failed_jev_final: 'Analysis unavailable · Jev made the final choice',
  skipped_by_jev: 'Jev kept the direct choice',
  reconsidered: 'Reasoning consulted · Jev reconsidered',
  insufficient_time: 'Initial Jev choice retained · time limit',
  insufficient_time_after_analysis: 'Initial Jev choice retained · time limit',
  analysis_or_reconsider_failed: 'Initial Jev choice retained · provider failure',
};
const purposes: Record<string, string> = {
  decision: 'Jev decision',
  route_and_decision: 'Initial Jev choice and routing',
  analysis: 'Reasoning analysis',
  reconsider: 'Final Jev choice',
};

export function DecisionAnalysis({ decision }: { decision: DecisionView }) {
  const routing = decision.routing ?? {};
  const session = asRecord(decision.context.session);
  const analysis = text(routing.analysis);
  const thinking = text(routing.thinking);
  const outcome = text(routing.outcome);
  const initialId = text(routing.initialCandidateId);
  const initial = decision.candidates.find((item) => item.id === initialId);
  const final = decision.candidates.find((item) => item.id === decision.selectedCandidateId);
  const turn = finite(session.turn);
  const sessionId = text(session.id);
  const model = text(routing.actualModel);
  const errorCode = text(routing.errorCode);
  const cancelled = decision.status === 'cancelled';
  const failed = decision.status === 'failed' || decision.source === 'unavailable';
  const analysisConfiguration = [...(decision.attempts ?? [])]
    .reverse()
    .find((attempt) => attempt.purpose === 'analysis' && attempt.configuration)?.configuration;
  return (
    <div className="decision-analysis" aria-label="Decision analysis">
      <div className="analysis-session-meta">
        <div>
          <span>Hand session</span>
          <strong>{sessionId ?? decision.handId}</strong>
        </div>
        <div>
          <span>{turn === null ? 'Decision' : `Turn ${number(turn)}`}</span>
          <strong>{decision.id}</strong>
        </div>
      </div>
      {!decision.framework && (
        <section className="analysis-recommendation" aria-label="Provider recommendation">
          <div className="analysis-section-heading">
            <p className="eyebrow">REASONING MODEL</p>
            <h4>Provider recommendation</h4>
            {model && <p className="annotation">Returned by {model}</p>}
          </div>
          {analysis ? (
            <p className="analysis-prose">{analysis}</p>
          ) : (
            <p className="analysis-empty">This record does not include a provider analysis.</p>
          )}
          <div className="analysis-thinking">
            <h5>
              {routing.thinkingSource === 'thinking'
                ? 'Provider thinking'
                : 'Provider thinking summary'}
            </h5>
            {thinking ? (
              <p className="analysis-prose analysis-thinking-text">{thinking}</p>
            ) : (
              <p className="analysis-empty">
                {analysisConfiguration?.thinking === 'disabled'
                  ? 'Thinking was disabled for this request.'
                  : 'No thinking text or summary was returned in this record.'}
              </p>
            )}
            {thinking && (
              <p className="annotation">Text returned by the provider; displayed as recorded.</p>
            )}
          </div>
        </section>
      )}
      <section className="analysis-choice" aria-label="Recorded choice comparison">
        {initialId && (
          <div>
            <span>Initial Jev choice</span>
            <strong>{initial?.label ?? initialId}</strong>
          </div>
        )}
        <div>
          <span>
            {cancelled || failed
              ? 'Submission outcome'
              : decision.source === 'jev'
                ? 'Final Jev choice'
                : decision.source === 'fallback'
                  ? 'Runtime fallback choice'
                  : 'Recorded policy choice'}
          </span>
          <strong>
            {cancelled || failed
              ? 'No action submitted'
              : (final?.label ?? 'No selected candidate recorded')}
          </strong>
          {cancelled && final && (
            <p className="annotation">Unsubmitted recommendation: {final.label}</p>
          )}
        </div>
        {initialId && !cancelled && !failed && (
          <p className="annotation">
            {initialId === decision.selectedCandidateId
              ? 'The initial Jev choice was retained.'
              : decision.source === 'jev'
                ? 'Jev changed its choice after analysis.'
                : 'The recorded choice differs from the initial Jev choice.'}
          </p>
        )}
      </section>
      <DecisionEvidence context={decision.context} />
      <section className="provider-trace analysis-call-trace" aria-label="Provider trace">
        <p className="eyebrow">RECORDED CALLS</p>
        {failed ? (
          <h4>Model decision failed · bot paused</h4>
        ) : cancelled ? (
          <h4>Decision cancelled before submission</h4>
        ) : (
          outcome && <h4>{outcomes[outcome] ?? outcome.replaceAll('_', ' ')}</h4>
        )}
        {errorCode && (
          <div className="warning-notice">Provider failure: {errorCode.replaceAll('_', ' ')}</div>
        )}
        {!decision.attempts?.length && (
          <p className="analysis-empty">No per-call trace was recorded for this decision.</p>
        )}
        {decision.attempts?.map((attempt, index) => {
          const fields = asRecord(attempt);
          const purpose = text(fields.purpose);
          const failure = text(fields.errorCode);
          const retry = retryLabel(attempt.retryIndex, attempt.maxRetries);
          return (
            <div className="provider-attempt" key={`${attempt.provider}-${index}`}>
              <span className="attempt-number">{index + 1}</span>
              <div>
                <strong>
                  {purpose ? (purposes[purpose] ?? purpose.replaceAll('_', ' ')) : attempt.provider}{' '}
                  · {attempt.actualModel ?? 'Model not reported'}
                </strong>
                <small>
                  {attempt.provider} · Requested: {attempt.requestedModel} ·{' '}
                  {number(attempt.latencyMs)} ms
                </small>
                {attempt.configuration && (
                  <small>
                    Thinking {attempt.configuration.thinking}
                    {attempt.configuration.effort && <> · Effort {attempt.configuration.effort}</>}
                  </small>
                )}
                {retry && <small>{retry}</small>}
                {failure && (
                  <small className="analysis-call-error">{failure.replaceAll('_', ' ')}</small>
                )}
              </div>
              <Status>{attempt.status.replaceAll('_', ' ')}</Status>
            </div>
          );
        })}
        {decision.routing && (
          <JsonDetails
            className="routing-details"
            title="Inspect routing record"
            value={decision.routing}
          ></JsonDetails>
        )}
      </section>
    </div>
  );
}
