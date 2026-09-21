import type { HandSummary, RunSummary, RuntimeView } from '../../../src/shared/api';
import { dollars, number, policyLabel, signed, time } from '../api';
import { Cards, Empty, ErrorNotice, Icon, Panel, SourceBadge, Status } from '../components/UI';
import { AccountFunding } from '../components/AccountFunding';
import type { FundingHistoryState } from '../funding-history';

function Performance({ hands }: { hands: HandSummary[] }) {
  let running = 0;
  const points = [
    { label: 'Start', value: 0 },
    ...[...hands]
      .filter((hand) => hand.complete && hand.profit !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((hand) => ({ label: `Hand ${hand.handNumber}`, value: (running += hand.profit ?? 0) })),
  ];
  if (points.length < 2)
    return (
      <Empty title="A curve starts with a hand">
        Completed hands will appear here as results arrive.
      </Empty>
    );
  const values = points.map((point) => point.value);
  const low = Math.min(0, ...values);
  const high = Math.max(1, ...values);
  const y = (value: number) => 176 - ((value - low) / (high - low)) * 145;
  const xy = points.map(
    (point, index) => `${50 + (index / (points.length - 1)) * 650},${y(point.value)}`,
  );
  return (
    <div className="performance-chart">
      <svg
        viewBox="0 0 740 216"
        role="img"
        aria-label={`Cumulative settled profit: ${signed(running)} chips across ${points.length - 1} hands`}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b7f78a" stopOpacity=".20" />
            <stop offset="100%" stopColor="#b7f78a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1="50"
              x2="710"
              y1={31 + fraction * 145}
              y2={31 + fraction * 145}
              stroke="#28332e"
              strokeDasharray="3 5"
            />
            <text x="0" y={35 + fraction * 145} fill="#84978a" fontSize="11">
              {number(high - fraction * (high - low))}
            </text>
          </g>
        ))}
        <path d={`M${xy.join(' L')} L700,176 L50,176 Z`} fill="url(#chart-fill)" />
        <line x1="50" x2="710" y1={y(0)} y2={y(0)} stroke="#536256" strokeDasharray="3 5" />
        <polyline
          points={xy.join(' ')}
          fill="none"
          stroke="#b7f78a"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {points.map((point, index) => (
          <circle
            key={index}
            cx={50 + (index / (points.length - 1)) * 650}
            cy={y(point.value)}
            r="3"
            fill="#b7f78a"
          >
            <title>
              {point.label}: {signed(point.value)} chips
            </title>
          </circle>
        ))}
        <text x="50" y="205" fill="#84978a" fontSize="11">
          First loaded hand
        </text>
        <text x="700" y="205" textAnchor="end" fill="#84978a" fontSize="11">
          Latest settled hand
        </text>
      </svg>
    </div>
  );
}

export function Overview({
  runtime,
  fundingHistory,
  run,
  hands,
  openHand,
  navigate,
  historyLoading,
  historyError,
  retryHistory,
}: {
  runtime: RuntimeView;
  fundingHistory: FundingHistoryState;
  run: RunSummary | undefined;
  hands: HandSummary[];
  openHand: (id: string) => void;
  navigate: (view: string) => void;
  historyLoading: boolean;
  historyError: string | null;
  retryHistory: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">AUTONOMOUS DECISION INTELLIGENCE</p>
          <h1>
            Every decision.
            <br className="mobile-break" /> An open record.
          </h1>
          <p className="subtle">A Jev agent at the table. The evidence behind every action.</p>
        </div>
        <button className="button secondary" onClick={() => navigate('live')}>
          Open live table <Icon name="arrow" size={16} />
        </button>
      </div>
      <AccountFunding runtime={runtime} history={fundingHistory} />
      <div className="metrics-grid">
        <article className="metric">
          <span>
            Net result <small>CHIPS</small>
          </span>
          <strong
            className={
              run?.settledHands ? (run.netChips >= 0 ? 'positive' : 'negative') : undefined
            }
          >
            {run?.settledHands ? signed(run.netChips) : '—'}
          </strong>
          <p>Historical settlements · selected run</p>
        </article>
        <article className="metric">
          <span>
            Win rate <small>BB / 100</small>
          </span>
          <strong>{run?.bb100 == null ? '—' : signed(run.bb100)}</strong>
          <p>
            {number(run?.settledHands ?? 0)} verified · {number(run?.excludedHands ?? 0)} excluded
          </p>
        </article>
        <article className="metric">
          <span>
            Decisions <small>TRACED</small>
          </span>
          <strong>{number(run?.decisions ?? 0)}</strong>
          <p>{number(run?.fallbackCount ?? 0)} fallback actions</p>
        </article>
        <article className="metric">
          <span>
            Model cost <small>ESTIMATED</small>
          </span>
          <strong>{dollars(run?.costUsd ?? 0)}</strong>
          <p>Usage + unknown reservations · not balance</p>
        </article>
      </div>
      <div className="overview-grid">
        <Panel
          title="Performance, with provenance"
          eyebrow="CUMULATIVE NET CHIPS"
          action={run && <SourceBadge mode={run.mode} />}
        >
          <Performance hands={hands} />
          <p className="annotation">
            Curve covers {hands.filter((hand) => hand.complete && hand.profit !== null).length}{' '}
            loaded, verified hands. Run metrics above include all verified hands.
          </p>
          <footer className="panel-footer">
            <span className="legend-dot" />
            Selected run only. Demo results never count as Arena results.
          </footer>
        </Panel>
        <Panel title="Agent profile" eyebrow="THE PLAYER" className="agent-panel">
          <div className="agent-avatar">
            J<span>♠</span>
          </div>
          <h3>Jev Decision Agent</h3>
          <p className="subtle">6-max No-Limit Texas Hold’em</p>
          <dl className="key-values">
            <div>
              <dt>Policy</dt>
              <dd>{run ? policyLabel(run.strategy) : 'Not selected'}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{run?.mode === 'demo' ? 'Synthetic demonstration' : (run?.model ?? '—')}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>OpenPoker.ai · V2</dd>
            </div>
            <div>
              <dt>Run state</dt>
              <dd>
                <Status>{run?.status ?? 'idle'}</Status>
              </dd>
            </div>
          </dl>
          <a href="https://openpoker.ai" target="_blank" rel="noreferrer" className="text-link">
            Explore the Arena <Icon name="external" size={14} />
          </a>
        </Panel>
      </div>
      <Panel
        title="Recent hands"
        eyebrow="FOLLOW THE EVIDENCE"
        action={
          <button className="text-link" onClick={() => navigate('replay')}>
            All hands <Icon name="arrow" size={15} />
          </button>
        }
      >
        <ErrorNotice error={historyError} />
        {historyError && (
          <button className="button secondary" onClick={retryHistory}>
            Retry hand history
          </button>
        )}
        {historyLoading && !hands.length ? (
          <p role="status">Loading hand history…</p>
        ) : !hands.length ? (
          <Empty title="No hands recorded">
            Select another run or watch the live table while new hands are recorded.
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Hand</th>
                  <th>Board</th>
                  <th>Result</th>
                  <th>Status</th>
                  <th>Recorded</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {hands.slice(0, 5).map((hand) => (
                  <tr key={hand.id}>
                    <td>
                      <button className="row-link" onClick={() => openHand(hand.id)}>
                        #{String(hand.handNumber).padStart(3, '0')}
                      </button>
                    </td>
                    <td>
                      <Cards cards={hand.board} size="small" />
                    </td>
                    <td
                      className={
                        hand.profit === null
                          ? undefined
                          : hand.profit >= 0
                            ? 'positive'
                            : 'negative'
                      }
                    >
                      {hand.profit === null
                        ? hand.status === 'complete'
                          ? 'Unverified'
                          : 'Pending'
                        : `${signed(hand.profit)} chips`}
                    </td>
                    <td>
                      <Status>{hand.status}</Status>
                    </td>
                    <td className="subtle">{time(hand.startedAt)}</td>
                    <td>
                      <button
                        aria-label={`Replay hand ${hand.handNumber}`}
                        className="icon-button"
                        onClick={() => openHand(hand.id)}
                      >
                        <Icon name="arrow" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="integrity-note">
        <Icon name="lock" size={14} />
        <span>
          Watch live play and explore completed hands. Decisions run autonomously on the server.
        </span>
      </div>
    </>
  );
}
