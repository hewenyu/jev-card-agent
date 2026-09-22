import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DecisionView,
  HandSummary,
  Overview as OverviewData,
  RunSummary,
} from '../../src/shared/api';
import { api, message } from './api';
import { useLiveSpectator } from './live';
import { Empty, ErrorNotice, Icon, SourceBadge } from './components/UI';
import { Overview } from './views/Overview';
import { Live } from './views/Live';
import { Replay } from './views/Replay';
import { Experiments } from './views/Experiments';
import { mergeHistory, useHistoryPages } from './history';
import { latestFunding } from './funding';
import { useFundingHistory } from './funding-history';
import { latestRuntime } from './runtime-view';

const views = [
  { id: 'overview', label: 'Overview' },
  { id: 'live', label: 'Live table' },
  { id: 'replay', label: 'Replay & decisions' },
  { id: 'experiments', label: 'Evaluations' },
];
const initialView = () =>
  views.some((view) => view.id === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

export function App() {
  const [view, setView] = useState(initialView);
  const [data, setData] = useState<OverviewData | null>(null);
  const [runId, setRunId] = useState('');
  const followCurrentRun = useRef(true);
  const [handId, setHandId] = useState<string | null>(null);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refreshing = useRef(false);
  const [overviewStartedAt, setOverviewStartedAt] = useState(0);
  const live = useLiveSpectator();
  const fundingHistory = useFundingHistory();
  const displayData = data && {
    ...data,
    runtime: {
      ...latestRuntime(data.runtime, live.snapshot?.runtime, live.receivedAt >= overviewStartedAt),
      funding: latestFunding(
        data.runtime.funding,
        live.snapshot?.runtime.funding,
        live.receivedAt >= overviewStartedAt,
      ),
    },
  };
  const runPages = useHistoryPages<RunSummary>(data ? '/runs' : null, revision);
  const runs = mergeHistory(runPages.items, data?.runs ?? []);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const startedAt = performance.now();
    try {
      const value = await api<OverviewData>('/overview');
      setData(value);
      setOverviewStartedAt(startedAt);
      setRevision((current) => current + 1);
      setError(null);
    } catch (reason) {
      setError(message(reason));
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    const handler = () => setView(initialView());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  const currentRunId = displayData?.runtime.runId ?? runs[0]?.id;
  const automaticRunId = runs.some((item) => item.id === currentRunId) ? currentRunId : runs[0]?.id;
  useEffect(() => {
    if (followCurrentRun.current && automaticRunId) setRunId(automaticRunId);
    else if (!runId && automaticRunId) setRunId(automaticRunId);
  }, [automaticRunId, runId]);
  const run = runs.find((item) => item.id === runId);
  const handPages = useHistoryPages<HandSummary>(
    runId ? `/hands?runId=${encodeURIComponent(runId)}` : null,
    revision,
  );
  const hands = handPages.items;
  const navigate = (next: string) => {
    location.hash = next;
    setView(next);
  };
  const openHand = (id: string) => {
    setHandId(id);
    setDecisionId(null);
    navigate('replay');
  };
  async function openDecision(id: string) {
    try {
      const decision = await api<DecisionView>(`/decisions/${encodeURIComponent(id)}`);
      followCurrentRun.current = decision.runId === currentRunId;
      setRunId(decision.runId);
      setHandId(decision.handId);
      setDecisionId(decision.id);
      navigate('replay');
    } catch (reason) {
      setError(message(reason));
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Jev home">
          <span className="brand-symbol">♠</span>
          <span>
            jev<span className="brand-period">.</span>
            <small>PUBLIC OBSERVATORY</small>
          </span>
        </a>
        <div className="sidebar-section-label">OBSERVATORY</div>
        <nav aria-label="Main navigation">
          {views.map((item) => (
            <a
              href={`#${item.id}`}
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <Icon name={item.id} />
              <span>{item.label}</span>
              {item.id === 'live' && displayData?.runtime.running && <i className="dot pulse" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-card">
            <span className="demo-card-kicker">THE COMPLETE PICTURE</span>
            <h3>
              A hand. A choice.
              <br />
              The evidence.
            </h3>
            <p>Watch the agent play. Explore every recorded hand and decision.</p>
            <a className="text-link" href="#replay">
              Explore the history <Icon name="arrow" size={16} />
            </a>
          </div>
          <div className="sidebar-foot">
            Built with Jev <span>↗</span> Played on OpenPoker
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Observatory <span>/</span>
            <strong>{views.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="topbar-controls">
            {run && (
              <SourceBadge
                mode={run.mode}
                active={
                  run.mode === 'live' &&
                  displayData?.runtime.running &&
                  displayData.runtime.runId === run.id
                }
              />
            )}
            <label className="run-selector">
              <span className="sr-only">Selected run</span>
              <select
                aria-label="Selected run"
                value={runId}
                onChange={(event) => {
                  followCurrentRun.current = event.target.value === currentRunId;
                  setRunId(event.target.value);
                  setHandId(null);
                  setDecisionId(null);
                }}
              >
                {!runs.length && <option value="">No runs yet</option>}
                {runs.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.mode === 'demo'
                      ? 'Demo'
                      : item.mode === 'evaluation'
                        ? 'Evaluation'
                        : 'Arena'}{' '}
                    · {item.strategy} · {item.id.slice(0, 12)}
                    {item.id === currentRunId ? ' · Current' : ''}
                  </option>
                ))}
              </select>
            </label>
            <a
              className="repository-link"
              href="https://github.com/hewenyu/jev-card-agent"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub <Icon name="external" size={14} />
            </a>
            {(runPages.hasMore || runPages.error) && (
              <button
                className="button compact secondary"
                disabled={runPages.loading}
                onClick={() => void runPages.loadMore()}
              >
                {runPages.loading
                  ? 'Loading runs…'
                  : runPages.error
                    ? 'Retry runs'
                    : 'Load older runs'}
              </button>
            )}
          </div>
        </header>
        <main>
          <ErrorNotice error={error} />
          <ErrorNotice error={runPages.error} />
          {loading ? (
            <div className="loading-state" role="status">
              Loading the observatory…
            </div>
          ) : !displayData ? (
            <Empty title="The observatory is unavailable">
              <button className="button secondary" onClick={() => void refresh()}>
                Retry connection
              </button>
            </Empty>
          ) : (
            <>
              {view === 'overview' && (
                <Overview run={run} revision={revision} runtime={displayData.runtime} />
              )}
              {view === 'live' && (
                <Live
                  runtime={displayData.runtime}
                  fundingHistory={fundingHistory}
                  runs={runs}
                  live={live}
                />
              )}
              {view === 'replay' && (
                <Replay
                  run={run}
                  hands={hands}
                  selectedHand={handId}
                  selectedDecision={decisionId}
                  selectHand={openHand}
                  historyLoading={handPages.loading}
                  historyError={handPages.error}
                  hasMoreHands={handPages.hasMore}
                  loadOlderHands={() => void handPages.loadMore()}
                />
              )}
              {view === 'experiments' && (
                <Experiments openDecision={(id) => void openDecision(id)} />
              )}
            </>
          )}
          <footer className="main-footer">
            <span>Jev Autonomous Decision Agent</span>
            <span>
              Observability over intuition. <i>♠</i>
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
