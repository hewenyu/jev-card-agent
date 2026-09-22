import { useEffect, useState } from 'react';
import type { RunSummary, RuntimeView } from '../../../src/shared/api';
import { number, signed, time } from '../api';
import { Empty, ErrorNotice, Panel } from '../components/UI';
import { PerformanceChart } from '../components/PerformanceChart';
import { useRunPerformance } from '../performance';
import { currentScorePoints, fundingIsStale } from '../season-score';
import './overview.css';

export function Overview({
  run,
  revision,
  runtime,
}: {
  run: RunSummary | undefined;
  revision: number;
  runtime: RuntimeView;
}) {
  const { data, error } = useRunPerformance(run?.id, revision);
  const [curve, setCurve] = useState<'profit' | 'score'>('profit');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const currentRun = !!run && run.id === runtime.runId;
  const funding = runtime.funding;
  const score = currentRun ? (funding?.seasonScore ?? null) : (data?.score ?? null);
  const scoreAt = currentRun ? funding?.updatedAt : data?.scoreObservedAt;
  const legacy = !currentRun && score !== null && data?.scoreSource !== 'official';
  const stale = currentRun && fundingIsStale(funding, now);
  const scoreLabel = legacy ? 'Historical balance estimate' : 'Season score';
  const scoreStatus = legacy
    ? 'Legacy account + table balance · not official score'
    : currentRun
      ? score === null
        ? 'Official score not yet reported'
        : stale
          ? 'Last confirmed official score · refresh delayed'
          : 'Current official account score'
      : 'Latest recorded official score for this run';
  const profitPoints =
    data?.settledHands && run
      ? [
          { at: run.startedAt, value: 0 },
          ...data.profitPoints.map((point) => ({ at: point.at, value: point.netChips })),
        ]
      : [];
  const scorePoints = (
    currentRun ? currentScorePoints(data, funding) : (data?.scorePoints ?? [])
  ).map((point) => ({ at: point.at, value: point.score }));
  return (
    <div className="results-overview">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PERFORMANCE</p>
          <h1>Results at a glance.</h1>
          <p className="subtle">
            {currentRun
              ? 'Current run · live official score · recorded results'
              : 'Selected historical run · recorded results and score'}
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      {!run ? (
        <Empty title="No runs recorded">Statistics appear when the agent starts playing.</Empty>
      ) : (
        <>
          {run.fallbackCount > 0 && (
            <p className="warning-notice">
              This run includes {number(run.fallbackCount)} historical runtime fallback decisions.
              These results include their outcomes and are not a pure Jev comparison.
            </p>
          )}
          <div className="metrics-grid results-metrics">
            <article className="metric">
              <span>
                Net result <small>CHIPS</small>
              </span>
              <strong
                data-testid="overview-net"
                className={
                  data?.settledHands ? (data.netChips >= 0 ? 'positive' : 'negative') : undefined
                }
              >
                {data?.settledHands ? signed(data.netChips) : '—'}
              </strong>
              <p>Verified settlements · excludes rebuys</p>
            </article>
            <article className="metric">
              <span>
                Win rate <small>HANDS</small>
              </span>
              <strong data-testid="overview-win-rate">
                {data?.winRate == null ? '—' : `${number(data.winRate)}%`}
              </strong>
              <p>Profitable hands / verified hands</p>
            </article>
            <article className="metric">
              <span>
                {scoreLabel} <small>CHIPS</small>
              </span>
              <strong data-testid="overview-score">{score === null ? '—' : number(score)}</strong>
              <p data-testid="overview-score-status">{scoreStatus}</p>
              {scoreAt && <p className="score-timestamp">Recorded {time(scoreAt)}</p>}
            </article>
          </div>
          <Panel
            title={curve === 'profit' ? 'Cumulative net profit' : scoreLabel}
            eyebrow="RESULTS OVER TIME"
            className="results-panel"
            action={
              <div className="curve-switch" role="group" aria-label="Chart metric">
                <button
                  type="button"
                  aria-pressed={curve === 'profit'}
                  onClick={() => setCurve('profit')}
                >
                  Net profit
                </button>
                <button
                  type="button"
                  aria-pressed={curve === 'score'}
                  onClick={() => setCurve('score')}
                >
                  {legacy ? 'Historical estimate' : 'Season score'}
                </button>
              </div>
            }
          >
            {!data && !error && !(curve === 'score' && scorePoints.length) ? (
              <p className="results-loading" role="status">
                Loading statistics…
              </p>
            ) : !data && !(curve === 'score' && scorePoints.length) ? (
              <Empty title="Statistics unavailable">Retrying automatically.</Empty>
            ) : (
              <PerformanceChart
                points={curve === 'profit' ? profitPoints : scorePoints}
                kind={curve}
                hands={data?.settledHands ?? 0}
                scoreLabel={scoreLabel}
              />
            )}
            <footer className="panel-footer results-footer">
              <span>
                {data
                  ? `${number(data.settledHands)} verified · ${number(data.excludedHands)} excluded`
                  : 'Awaiting statistics'}
              </span>
              <span>
                {curve === 'profit'
                  ? `Net chips · excludes rebuys${data && data.settledHands > data.profitPoints.length ? ' · sampled curve' : ''}`
                  : scoreAt
                    ? `${legacy ? 'Legacy estimate' : 'Official score'} · recorded ${time(scoreAt)}`
                    : 'Awaiting an official score snapshot'}
              </span>
            </footer>
          </Panel>
        </>
      )}
    </div>
  );
}
