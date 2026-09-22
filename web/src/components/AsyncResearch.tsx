import { useEffect, useState } from 'react';
import type { ResearchPublicView, ResearchSummary } from '../../../src/shared/research';
import { api, dollars, number, time } from '../api';
import { Panel, Status } from './UI';
import './fast-slow.css';

export function AsyncResearch({ summary }: { summary?: ResearchSummary }) {
  const [view, setView] = useState<ResearchPublicView | null>(null);
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api<ResearchPublicView>('/research');
        if (active) setView(result);
      } catch {
        // Retain the last observation. Runtime summary can still arrive through SSE.
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, []);
  const status = view?.status ?? summary;
  if (!status) return null;
  const mode = status.mode.toUpperCase();
  return (
    <Panel
      title="LLM research"
      eyebrow="BACKGROUND ANALYSIS · JEV CHOOSES EACH ACTION"
      action={<Status>{mode}</Status>}
    >
      <section aria-label="LLM research status">
        <p className="annotation">
          {status.mode === 'off'
            ? 'Research is off. Jev uses the existing statistics and strategy references.'
            : status.mode === 'shadow'
              ? 'Research runs in shadow. Its proposals are recorded and cannot enter live Jev requests.'
              : 'Jev can use approved advice fixed at the start of each hand. It continues without waiting for research.'}
        </p>
        {status.configuredMode === 'live' && status.mode !== 'live' && (
          <p className="annotation">
            Live advice has not been activated, or the operator has disabled it.
          </p>
        )}
        {status.error && (
          <p className="warning-notice" role="status">
            Research needs attention. Current actions continue with their fixed knowledge.
          </p>
        )}
        <dl className="fast-slow-facts">
          <div>
            <dt>Research worker</dt>
            <dd>{status.running ? 'Running' : 'Idle'}</dd>
          </div>
          <div>
            <dt>Queued / executing</dt>
            <dd>
              {number(status.pending)} / {number(status.executing)}
            </dd>
          </div>
          <div>
            <dt>Awaiting review / approved</dt>
            <dd>
              {number(status.awaitingReview)} / {number(status.approved)}
            </dd>
          </div>
          <div>
            <dt>Published / expired / withdrawn</dt>
            <dd>
              {number(status.published)} / {number(status.expired)} / {number(status.withdrawn)}
            </dd>
          </div>
          <div>
            <dt>Failed research jobs</dt>
            <dd>{number(status.failed)}</dd>
          </div>
          <div>
            <dt>Last completed research</dt>
            <dd>{status.lastCompletedAt ? time(status.lastCompletedAt) : 'None recorded'}</dd>
          </div>
          <div>
            <dt>Advice adopted in actual requests</dt>
            <dd>
              {number(status.adoptedDecisions)} / {number(status.evaluatedDecisions)} live decisions
            </dd>
          </div>
          <div>
            <dt>Live decisions without a matching suggestion</dt>
            <dd>{number(status.unmatchedDecisions)}</dd>
          </div>
          <div>
            <dt>Research calls / unknown usage</dt>
            <dd>
              {number(status.attempts)} / {number(status.unknownUsageCalls)}
            </dd>
          </div>
          <div>
            <dt>Known research cost estimate</dt>
            <dd>
              {status.knownCostUsd === null ? 'Unknown' : dollars(status.knownCostUsd)}
              {status.knownCostUsd !== null && status.unpricedCalls > 0 ? ' + unpriced calls' : ''}
            </dd>
          </div>
          <div>
            <dt>Latest advice age</dt>
            <dd>
              {status.latestAdviceAgeMs === null
                ? 'No advice published'
                : `${number(Math.floor(status.latestAdviceAgeMs / 60000))} min`}
            </dd>
          </div>
        </dl>
        {!!view?.publications.length && (
          <details className="context-details">
            <summary>Published advice history</summary>
            <div className="research-publications">
              {view.publications.map((item) => (
                <article key={item.id}>
                  <p>
                    <Status>{item.status}</Status> <strong>Revision {item.revision}</strong>
                  </p>
                  <p>{item.guidance}</p>
                  <p className="annotation">
                    {item.approvalSource} · Published {time(item.publishedAt)} · Expires{' '}
                    {time(item.expiresAt)}
                  </p>
                  <p className="annotation">Evidence cutoff {time(item.evidenceCutoff)}</p>
                </article>
              ))}
            </div>
          </details>
        )}
        {!!view?.proposals.length && (
          <details className="context-details">
            <summary>Research proposal history</summary>
            <div className="research-publications">
              {view.proposals.map((item) => (
                <article key={item.id}>
                  <strong>
                    {item.kind === 'opponent_brief' ? 'Opponent brief' : 'Decision review'}
                  </strong>{' '}
                  <Status>{item.status}</Status>
                  <p className="annotation">
                    {number(item.evidenceHands)} completed hands ·{' '}
                    {item.model ?? 'Model identity unavailable'} · {time(item.receivedAt)}
                  </p>
                </article>
              ))}
            </div>
          </details>
        )}
        <p className="annotation">
          Adoption means advice was present in the saved Jev request. It does not establish a better
          action or greater profit. Review and publication are private operator actions.
        </p>
      </section>
    </Panel>
  );
}
