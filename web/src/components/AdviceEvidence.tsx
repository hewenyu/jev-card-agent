import type { DecisionView } from '../../../src/shared/api';
import type { DecisionAdvice } from '../../../src/core/advice';

export function AdviceEvidence({ decision }: { decision: DecisionView }) {
  const advice = decision.context.advice as DecisionAdvice | undefined;
  if (!advice) return null;
  const actual = decision.modelInput?.approvedAdvice;
  const adopted = Array.isArray(actual) && actual.length > 0;
  return (
    <section aria-label="Advice used by Jev" className="fast-slow-audit">
      <h4>Asynchronous advice · {advice.mode}</h4>
      <p className="annotation">
        Action source: {decision.source}. Knowledge: {adopted ? 'LLM-assisted' : 'deterministic'}.
      </p>
      <p>
        {adopted
          ? 'Approved advice is present in this saved Jev request.'
          : advice.mode === 'shadow'
            ? 'Shadow research did not enter this Jev request.'
            : 'No approved advice was included in this request.'}
      </p>
      {adopted &&
        advice.items.map((item) => (
          <article key={item.id} className="fast-slow-audit">
            <p>
              <strong>{item.observation}</strong>
            </p>
            <p>{item.guidance}</p>
            <p className="annotation">{item.evidence.join(' · ')}</p>
            <p className="annotation">{item.limitations.join(' · ')}</p>
          </article>
        ))}
      <details className="context-details">
        <summary>Advice provenance and selection</summary>
        <dl className="fast-slow-facts">
          <div>
            <dt>Actual Jev request hash</dt>
            <dd>{decision.requestHash ?? 'Not recorded'}</dd>
          </div>
          <div>
            <dt>Fixed advice bundle</dt>
            <dd>{advice.bundleHash}</dd>
          </div>
          <div>
            <dt>Selection boundary</dt>
            <dd>{advice.selectionAt}</dd>
          </div>
          <div>
            <dt>Selector</dt>
            <dd>{advice.selectorVersion}</dd>
          </div>
          <div>
            <dt>Publication IDs</dt>
            <dd>{advice.publicationIds.join(', ') || 'None'}</dd>
          </div>
        </dl>
        {advice.audit.map((item, index) => (
          <p className="annotation" key={`${item.id}-${index}`}>
            {item.id}: {item.reason.replaceAll('_', ' ')}
          </p>
        ))}
      </details>
    </section>
  );
}
