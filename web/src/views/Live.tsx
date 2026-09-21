import { useState } from 'react';
import type { Overview, RuntimeView, StrategyName } from '../../../src/shared/api';
import { api, message } from '../api';
import { PokerTable } from '../components/PokerTable';
import { ErrorNotice, Panel, SourceBadge, Status } from '../components/UI';

export function Live({ data, refresh }: { data: Overview; refresh: () => Promise<void> }) {
  const [strategy, setStrategy] = useState<StrategyName>('jev');
  const [maxHands, setMaxHands] = useState('30');
  const [maxMinutes, setMaxMinutes] = useState('30');
  const [budget, setBudget] = useState('1');
  const [autoRebuy, setAutoRebuy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtime = data.runtime;
  async function control(action: 'start' | 'stop') {
    setBusy(true);
    setError(null);
    try {
      if (action === 'start')
        await api<RuntimeView>('/runtime/start', {
          strategy,
          buyIn: 2000,
          maxHands: Number(maxHands),
          maxMinutes: Number(maxMinutes),
          budgetUsd: Number(budget),
          autoRebuy,
        });
      else await api<RuntimeView>('/runtime/stop', {});
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const canStart =
    data.capabilities.canControl &&
    data.capabilities.liveConfigured &&
    (strategy === 'baseline' || data.capabilities.jevConfigured) &&
    (strategy !== 'jev-reasoning' || data.capabilities.reasoningConfigured === true);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CONNECTED TO THE ARENA</p>
          <h1>The agent’s table.</h1>
          <p className="subtle">
            Autonomous play, bounded runs, and a clear view of runtime state.
          </p>
        </div>
        <SourceBadge
          mode={runtime.mode === 'live' ? 'live' : runtime.mode === 'demo' ? 'demo' : 'recorded'}
          active={runtime.running && runtime.mode === 'live'}
        />
      </div>
      <ErrorNotice error={error ?? runtime.error} />
      <div className="live-grid">
        <Panel
          className="table-panel"
          title={
            runtime.table?.tableId
              ? `Table ${runtime.table.tableId.slice(0, 12)}`
              : 'Waiting for the next hand'
          }
          eyebrow="6-MAX · NO-LIMIT HOLD’EM"
          action={<Status>{runtime.status}</Status>}
        >
          <PokerTable
            table={runtime.table}
            label={
              runtime.mode === 'demo'
                ? 'DEMO TABLE'
                : runtime.running
                  ? 'OPENPOKER ARENA'
                  : 'NO ACTIVE TABLE'
            }
          />
          <div className="panel-footer">
            <span className={`legend-dot ${runtime.running ? '' : 'muted-dot'}`} />
            {runtime.running
              ? 'Runtime is active. Updates refresh every 3 seconds.'
              : 'Runtime is idle. Starting a live run enters the real Arena.'}
          </div>
        </Panel>
        <Panel title="Run controls" eyebrow="AUTONOMY WITH LIMITS">
          <form
            className="run-form"
            onSubmit={(event) => {
              event.preventDefault();
              void control('start');
            }}
          >
            <label className="field">
              Decision policy
              <select
                value={strategy}
                onChange={(event) => setStrategy(event.target.value as StrategyName)}
                disabled={runtime.running}
              >
                <option value="jev">Jev Choice</option>
                <option value="baseline">Rule baseline</option>
                {data.capabilities.reasoningConfigured && (
                  <option value="jev-reasoning">Jev + reasoning</option>
                )}
              </select>
            </label>
            {strategy === 'jev-reasoning' && (
              <p className="annotation">
                Jev decides when to request reasoning, then makes the final legal choice.
              </p>
            )}
            <div className="form-grid">
              <label className="field">
                Hand limit
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={maxHands}
                  onChange={(event) => setMaxHands(event.target.value)}
                  required
                  disabled={runtime.running}
                />
              </label>
              <label className="field">
                Minutes
                <input
                  type="number"
                  min="1"
                  max="1440"
                  value={maxMinutes}
                  onChange={(event) => setMaxMinutes(event.target.value)}
                  required
                  disabled={runtime.running}
                />
              </label>
            </div>
            <label className="field">
              Model budget · USD
              <input
                type="number"
                min="0.001"
                max="9"
                step="0.001"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                required
                disabled={runtime.running}
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={autoRebuy}
                onChange={(event) => setAutoRebuy(event.target.checked)}
                disabled={runtime.running}
              />
              Automatic virtual-chip rebuy
            </label>
            <div className="control-note">
              Buy-in: 2,000 virtual chips. A live run enters OpenPoker and may make paid Jev
              requests up to its configured limits.
            </div>
            {runtime.running ? (
              <button
                type="button"
                className="button danger full-width"
                disabled={busy || !data.capabilities.canControl}
                onClick={() => void control('stop')}
              >
                {busy ? 'Stopping…' : 'Stop live run'}
              </button>
            ) : (
              <button
                type="submit"
                className="button primary full-width"
                disabled={busy || !canStart}
              >
                {busy ? 'Connecting…' : 'Start live run'}
              </button>
            )}
            {!canStart && !runtime.running && (
              <p className="annotation">
                {!data.capabilities.canControl
                  ? 'Console access is required to control the agent.'
                  : !data.capabilities.liveConfigured
                    ? 'Configure OPENPOKER_API_KEY on the server to enter the Arena.'
                    : 'Configure the Jev API key on the server, or select baseline.'}
              </p>
            )}
          </form>
        </Panel>
      </div>
      <Panel title="Runtime contract" eyebrow="WHAT HAPPENS WITHOUT YOU">
        <div className="runtime-contract">
          <div>
            <span>01</span>
            <h3>Connect & recover</h3>
            <p>
              WebSocket V2 carries state. Reconnect and resync restore the latest action authority.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Decide & validate</h3>
            <p>
              Jev chooses from legal candidates. A deadline guard handles expired and failed
              requests.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Execute & record</h3>
            <p>
              Actions are tracked through acknowledgment. Every hand becomes a replayable record.
            </p>
          </div>
        </div>
      </Panel>
    </>
  );
}
