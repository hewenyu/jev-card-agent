import { useCallback, useEffect, useState } from 'react';
import type {
  DecisionView,
  HandSummary,
  Overview as OverviewData,
  RunSummary,
} from '../../src/shared/api';
import { api, getToken, message, saveToken } from './api';
import { Empty, ErrorNotice, Icon, SourceBadge } from './components/UI';
import { Overview } from './views/Overview';
import { Live } from './views/Live';
import { Replay } from './views/Replay';
import { Experiments } from './views/Experiments';
import { mergeHistory, useHistoryPages } from './history';

const views = [
  { id: 'overview', label: 'Overview' },
  { id: 'live', label: 'Live table' },
  { id: 'replay', label: 'Replay & decisions' },
  { id: 'experiments', label: 'Experiments' },
];
const initialView = () =>
  views.some((view) => view.id === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

export function App() {
  const [view, setView] = useState(initialView);
  const [data, setData] = useState<OverviewData | null>(null);
  const [runId, setRunId] = useState('');
  const [handId, setHandId] = useState<string | null>(null);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessOpen, setAccessOpen] = useState(false);
  const [token, setToken] = useState(getToken);
  const [demoBusy, setDemoBusy] = useState(false);
  const runPages = useHistoryPages<RunSummary>(data ? '/runs' : null, data?.runs[0]?.id);
  const runs = mergeHistory(runPages.items, data?.runs ?? []);
  const refresh = useCallback(async () => {
    try {
      const value = await api<OverviewData>('/overview');
      setData(value);
      setRunId((current) => current || value.runs[0]?.id || '');
      setError(null);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const handler = () => setView(initialView());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  const run = runs.find((item) => item.id === runId);
  const handCount = run?.hands;
  const handPages = useHistoryPages<HandSummary>(
    runId ? `/hands?runId=${encodeURIComponent(runId)}` : null,
    handCount,
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
      setRunId(decision.runId);
      setHandId(decision.handId);
      setDecisionId(decision.id);
      navigate('replay');
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function loadDemo() {
    const existing = data?.runs.find((item) => item.mode === 'demo');
    if (existing) {
      setRunId(existing.id);
      navigate('overview');
      return;
    }
    setDemoBusy(true);
    try {
      await api('/demo/reset', {});
      await refresh();
      navigate('overview');
    } catch (reason) {
      setError(message(reason));
    } finally {
      setDemoBusy(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Jev home">
          <span className="brand-symbol">♠</span>
          <span>
            jev<span className="brand-period">.</span>
            <small>DECISION CONSOLE</small>
          </span>
        </a>
        <div className="sidebar-section-label">WORKSPACE</div>
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
              {item.id === 'live' && data?.runtime.running && <i className="dot pulse" />}
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
            <p>Explore a recorded demonstration without connecting to the Arena.</p>
            <button className="text-link" onClick={() => void loadDemo()} disabled={demoBusy}>
              {demoBusy ? 'Loading…' : 'Explore demo'}
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <button className="access-button" onClick={() => setAccessOpen(true)}>
            <Icon name="lock" size={17} />
            Access settings<span>{getToken() ? 'Connected' : 'Local / public'}</span>
          </button>
          <div className="sidebar-foot">
            Built with Jev <span>↗</span> Played on OpenPoker
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>
            <strong>{views.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="topbar-controls">
            {run && (
              <SourceBadge
                mode={run.mode}
                active={
                  run.mode === 'live' && data?.runtime.running && data.runtime.runId === run.id
                }
              />
            )}
            <label className="run-selector">
              <span className="sr-only">Selected run</span>
              <select
                aria-label="Selected run"
                value={runId}
                onChange={(event) => {
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
                  </option>
                ))}
              </select>
            </label>
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
            <button
              className="icon-button mobile-access"
              aria-label="Access settings"
              onClick={() => setAccessOpen(true)}
            >
              <Icon name="lock" size={16} />
            </button>
          </div>
        </header>
        <main>
          <ErrorNotice error={error} />
          <ErrorNotice error={runPages.error} />
          {loading ? (
            <div className="loading-state" role="status">
              Connecting to the decision console…
            </div>
          ) : !data ? (
            <Empty title="The console is unavailable">
              <button className="button secondary" onClick={() => void refresh()}>
                Retry connection
              </button>
            </Empty>
          ) : (
            <>
              {view === 'overview' && (
                <Overview
                  data={data}
                  run={run}
                  hands={hands}
                  openHand={openHand}
                  navigate={navigate}
                  historyLoading={handPages.loading}
                  historyError={handPages.error}
                  retryHistory={() => void handPages.loadMore()}
                />
              )}
              {view === 'live' && <Live data={data} refresh={refresh} />}
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
                <Experiments
                  runs={runs}
                  selectedRunId={runId}
                  canControl={data.capabilities.canControl}
                  jevConfigured={data.capabilities.jevConfigured}
                  reasoningConfigured={data.capabilities.reasoningConfigured === true}
                  openDecision={(id) => void openDecision(id)}
                />
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
      {accessOpen && (
        <div className="modal-backdrop">
          <section
            className="access-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="access-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Close access settings"
              onClick={() => setAccessOpen(false)}
            >
              <Icon name="close" />
            </button>
            <p className="eyebrow">SERVER ACCESS</p>
            <h2 id="access-title">Connect your console.</h2>
            <p className="subtle">
              Use the console access token configured on your server. This is separate from your Jev
              and OpenPoker API keys.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveToken(token);
                // Rebuild all history caches when changing between private and public access.
                window.location.reload();
              }}
            >
              <label className="field">
                Console access token
                <input
                  autoFocus
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Optional on local connections"
                />
              </label>
              <p className="annotation">
                Stored only for this browser session. Never enter a provider API key here.
              </p>
              <button className="button primary full-width" type="submit">
                Save access settings
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
