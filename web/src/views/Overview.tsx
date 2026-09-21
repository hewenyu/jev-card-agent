import { useState } from 'react';
import type { RunSummary } from '../../../src/shared/api';
import { number, signed, time } from '../api';
import { Empty, ErrorNotice, Panel } from '../components/UI';
import { PerformanceChart } from '../components/PerformanceChart';
import { useRunPerformance } from '../performance';
import './overview.css';

export function Overview({ run, revision }: { run: RunSummary | undefined; revision: number }) {
  const { data, error } = useRunPerformance(run?.id, revision);
  const [curve, setCurve] = useState<'profit' | 'score'>('profit');
  const profitPoints =
    data?.settledHands && run
      ? [
          { at: run.startedAt, value: 0 },
          ...data.profitPoints.map((point) => ({ at: point.at, value: point.netChips })),
        ]
      : [];
  const scorePoints =
    data?.scorePoints.map((point) => ({ at: point.at, value: point.score })) ?? [];
  return (
    <div className="results-overview">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PERFORMANCE</p>
          <h1>Results at a glance.</h1>
          <p className="subtle">Selected run · full recorded history · automatically refreshed</p>
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
                Season score <small>CHIPS</small>
              </span>
              <strong data-testid="overview-score">
                {data?.score == null ? '—' : number(data.score)}
              </strong>
              <p
                title={data?.scoreObservedAt ? `Recorded ${time(data.scoreObservedAt)}` : undefined}
              >
                Official account snapshot · includes rebuys
              </p>
            </article>
          </div>
          <Panel
            title={curve === 'profit' ? 'Cumulative net profit' : 'Season score'}
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
                  Season score
                </button>
              </div>
            }
          >
            {!data && !error ? (
              <p className="results-loading" role="status">
                Loading statistics…
              </p>
            ) : !data ? (
              <Empty title="Statistics unavailable">Retrying automatically.</Empty>
            ) : (
              <PerformanceChart
                points={curve === 'profit' ? profitPoints : scorePoints}
                kind={curve}
                hands={data.settledHands}
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
                  : data?.scoreObservedAt
                    ? `Includes rebuys · recorded ${time(data.scoreObservedAt)}`
                    : 'Account chips + chips at table'}
              </span>
            </footer>
          </Panel>
        </>
      )}
    </div>
  );
}
