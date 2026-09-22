import type { RunSummary, RuntimeView, SpectatorEvent } from '../../../src/shared/api';
import { number, policyLabel, time } from '../api';
import type { LiveSpectator } from '../live';
import { PokerTable } from '../components/PokerTable';
import { HandSession } from '../components/HandSession';
import { ResearchStatus } from '../components/ResearchStatus';
import { AccountFunding } from '../components/AccountFunding';
import type { FundingHistoryState } from '../funding-history';
import { Empty, Icon, Panel, SourceBadge, Status } from '../components/UI';
import './live.css';

function actionLabel(event: SpectatorEvent, runtime: RuntimeView): string {
  const player = runtime.table?.seats.find((seat) => seat.seat === event.seat);
  const actor = player?.name ?? (event.seat === undefined ? '' : `Seat ${event.seat + 1}`);
  const action = (event.action ?? event.type).replaceAll('_', ' ');
  return `${actor} ${action}`.trim();
}

export function Live({
  runtime,
  fundingHistory,
  runs,
  live,
}: {
  runtime: RuntimeView;
  fundingHistory: FundingHistoryState;
  runs: RunSummary[];
  live: LiveSpectator;
}) {
  const run = runs.find((item) => item.id === runtime.runId);
  const arenaUrl =
    runtime.mode === 'live' &&
    runtime.running &&
    runtime.status === 'playing' &&
    runtime.table?.tableId
      ? `https://openpoker.ai/arena/${encodeURIComponent(runtime.table.tableId)}`
      : null;
  const events =
    live.snapshot?.runtime.runId === runtime.runId
      ? live.snapshot.recentEvents.filter(
          (event) =>
            event.tableId === runtime.table?.tableId && event.handId === runtime.table?.handId,
        )
      : [];
  return (
    <>
      <div className="page-heading spectator-heading">
        <div>
          <p className="eyebrow">AUTONOMOUS PLAY · OPEN OBSERVATION</p>
          <h1>The agent’s table.</h1>
          <p className="subtle">
            Follow each action as it happens. Every completed hand becomes a record.
          </p>
        </div>
        <span className={`spectator-connection ${live.status}`} role="status">
          <i className={`dot ${live.status === 'live' ? 'pulse' : ''}`} />
          {live.status === 'live'
            ? 'Live updates connected'
            : live.status === 'connecting'
              ? 'Connecting live updates…'
              : 'Reconnecting live updates…'}
        </span>
      </div>
      <div className="spectator-layout">
        <Panel
          title="Live table"
          eyebrow={runtime.mode === 'demo' ? 'RECORDED DEMONSTRATION' : 'OPENPOKER ARENA'}
          action={
            <div className="table-heading-actions">
              <Status>{runtime.status}</Status>
              {arenaUrl && (
                <a
                  className="arena-watch-link"
                  href={arenaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Watch on OpenPoker <Icon name="external" size={13} />
                </a>
              )}
            </div>
          }
        >
          <PokerTable
            table={runtime.table}
            label={runtime.mode === 'demo' ? 'SYNTHETIC DEMO' : 'LIVE TABLE'}
            animated={live.status === 'live'}
            events={events}
            motionEpoch={`${live.motionEpoch}:${runtime.runId ?? ''}`}
          />
          <p className="annotation spectator-chip-note">
            Available = chips left to bet. Bet = this street’s chips already in the pot.
          </p>
          <p className="annotation spectator-note">
            {runtime.table
              ? 'The agent’s own cards are shown. Follow its recorded analysis and choices in the hand session.'
              : 'The agent is between tables. The next table will appear automatically.'}
          </p>
        </Panel>
        <aside className="spectator-decisions" aria-label="Live decisions">
          <HandSession runtime={runtime} />
        </aside>
      </div>
      <div className="spectator-support">
        <AccountFunding runtime={runtime} history={fundingHistory} />
        <Panel title="At the table" eyebrow="THE AGENT">
          <dl className="key-values">
            <div>
              <dt>Policy</dt>
              <dd>{runtime.strategy ? policyLabel(runtime.strategy) : '—'}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{runtime.mode === 'demo' ? 'Synthetic demonstration' : (run?.model ?? '—')}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>{runtime.runId ?? 'Waiting'}</dd>
            </div>
            <div>
              <dt>Table</dt>
              <dd>{runtime.table?.tableId ?? 'Waiting'}</dd>
            </div>
            <div>
              <dt>Hand</dt>
              <dd>{runtime.table?.handId ?? 'Waiting'}</dd>
            </div>
            <div>
              <dt>Recorded hands</dt>
              <dd>{number(run?.hands ?? 0)}</dd>
            </div>
          </dl>
          {run && <SourceBadge mode={run.mode} active={runtime.running} />}
          <p className="annotation spectator-note">
            The agent plays autonomously. This page follows the game.
          </p>
        </Panel>
      </div>
      <ResearchStatus research={runtime.research} />
      <Panel title="Table activity" eyebrow="CONFIRMED ACTIONS">
        {!events.length ? (
          <Empty title="Waiting for the next action">
            Public actions will appear here as play continues.
          </Empty>
        ) : (
          <ol className="spectator-feed" aria-label="Public table activity">
            {[...events].reverse().map((event) => (
              <li key={event.id}>
                <time dateTime={event.at}>{time(event.at)}</time>
                <strong>{actionLabel(event, runtime)}</strong>
                <span>
                  {event.movements
                    .map(
                      (movement) =>
                        `${movement.direction === 'to-pot' ? 'To pot' : `To seat ${movement.seat + 1}`} · ${number(movement.amount)} chips`,
                    )
                    .join(' / ')}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}
