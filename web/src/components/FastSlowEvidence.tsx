import type { DecisionView } from '../../../src/shared/api';
import { number } from '../api';
import './fast-slow.css';

function stamp(value: string | null | undefined): string {
  return value ?? 'Not recorded';
}
function duration(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'Not recorded' : `${number(value)} ms`;
}
const auditLabels = {
  pending: 'Pending',
  disabled: 'Disabled',
  failed: 'Worker unavailable',
  complete: 'Complete',
  unavailable: 'No reliable reference',
};

export function FastSlowEvidence({ decision }: { decision: DecisionView }) {
  const binding = decision.knowledge;
  const audit = decision.audit;
  const timing = decision.timing;
  const estimate = audit?.uniformShowdownReference;
  return (
    <section className="fast-slow-evidence" aria-label="Knowledge and asynchronous audit">
      <p className="eyebrow">FAST CHOICE · PERSISTENT EVIDENCE</p>
      <h4>Knowledge fixed for this hand</h4>
      {binding ? (
        <>
          <dl className="fast-slow-facts">
            <div>
              <dt>Knowledge version</dt>
              <dd>{binding.pin.knowledgeVersion}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{binding.snapshot.source}</dd>
            </div>
            <div>
              <dt>Published at</dt>
              <dd>{stamp(binding.snapshot.publishedAt)}</dd>
            </div>
            <div>
              <dt>Evidence cutoff</dt>
              <dd>{stamp(binding.snapshot.evidenceCutoff)}</dd>
            </div>
            <div>
              <dt>Fixed at</dt>
              <dd>{stamp(binding.pin.pinnedAt)}</dd>
            </div>
            <div>
              <dt>Eligible publication boundary</dt>
              <dd>{stamp(binding.pin.admissibleAt)}</dd>
            </div>
            <div>
              <dt>Evidence event watermark</dt>
              <dd>{number(binding.pin.evidenceEventId)}</dd>
            </div>
            <div>
              <dt>Selection</dt>
              <dd>
                {binding.pin.reason === 'baseline' ? 'Baseline knowledge' : 'Published knowledge'}
              </dd>
            </div>
          </dl>
          <p className="annotation">
            This version stays fixed throughout the hand. Cards and current-hand actions continue to
            update. Baseline knowledge still leaves the action choice to Jev.
          </p>
          <details className="context-details">
            <summary>Knowledge provenance</summary>
            <dl className="fast-slow-facts">
              <div>
                <dt>Content hash</dt>
                <dd>{binding.pin.snapshotHash}</dd>
              </div>
              <div>
                <dt>Rules</dt>
                <dd>{binding.snapshot.rulesetVersion}</dd>
              </div>
              <div>
                <dt>Context schema</dt>
                <dd>{binding.snapshot.contextSchemaVersion}</dd>
              </div>
              <div>
                <dt>Expires at</dt>
                <dd>{binding.snapshot.expiresAt ?? 'No expiry recorded'}</dd>
              </div>
            </dl>
            <p className="annotation">
              Validation: {binding.snapshot.validation.join(' · ') || 'Not recorded'}
            </p>
          </details>
        </>
      ) : (
        <p className="annotation">Knowledge pin not recorded for this historical decision.</p>
      )}
      <div className="fast-slow-audit" aria-label="Asynchronous audit">
        <h4>Asynchronous audit · excluded from Jev input</h4>
        <p className="fast-slow-audit-state" role="status">
          {audit
            ? auditLabels[audit.status]
            : binding
              ? 'Pending or not yet available'
              : 'Not recorded for this historical decision'}
        </p>
        <p className="annotation">
          Computed after the decision from its frozen snapshot. This result was not supplied to Jev
          and does not change the saved model input.
        </p>
        {audit?.computedAt && <p className="annotation">Computed at {audit.computedAt}</p>}
        {estimate && (
          <>
            <p>
              <strong>{number(estimate.equity * 100)}%</strong> estimated pot share against{' '}
              {number(estimate.opponents)} uniformly random opponents.
            </p>
            <p className="annotation">
              {number(estimate.samples)} sampled deals · standard error{' '}
              {estimate.standardError === null
                ? 'not available'
                : `${number(estimate.standardError * 100)}%`}
              . This is not equity against these opponents’ betting ranges or the expected profit of
              an action.
            </p>
            {audit?.inputHash && (
              <details className="context-details">
                <summary>Audit input fingerprint</summary>
                <code>{audit.inputHash}</code>
              </details>
            )}
          </>
        )}
      </div>
      <details className="context-details" open={!!timing}>
        <summary>Decision stage timings</summary>
        {timing ? (
          <>
            <dl className="fast-slow-facts" aria-label="Decision stage timings">
              <div>
                <dt>State and facts preparation</dt>
                <dd>{duration(timing.preparationMs)}</dd>
              </div>
              <div>
                <dt>Knowledge read · within preparation</dt>
                <dd>{duration(timing.knowledgeMs)}</dd>
              </div>
              <div>
                <dt>Model attempts</dt>
                <dd>{duration(timing.providerMs)}</dd>
              </div>
              <div>
                <dt>Durable recording</dt>
                <dd>{duration(timing.persistenceMs)}</dd>
              </div>
              <div>
                <dt>Sending</dt>
                <dd>{duration(timing.sendMs)}</dd>
              </div>
              <div>
                <dt>Receipt to first send</dt>
                <dd>{duration(timing.receiptToSendMs)}</dd>
              </div>
              <div>
                <dt>First send to acknowledgement</dt>
                <dd>{duration(timing.ackMs)}</dd>
              </div>
            </dl>
            <p className="annotation">
              Knowledge read is part of preparation, not an additional stage. Missing send or
              acknowledgement values are not zero latency.
            </p>
          </>
        ) : (
          <p className="annotation">Stage timings not recorded for this historical decision.</p>
        )}
      </details>
    </section>
  );
}
