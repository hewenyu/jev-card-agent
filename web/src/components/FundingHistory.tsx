import type { FundingEventView } from '../../../src/shared/api';
import type { FundingHistoryState } from '../funding-history';
import { number, time } from '../api';

const amount = (value: number | null) => (value === null ? '—' : number(value));
function eventLabel(event: FundingEventView): string {
  if (event.kind === 'rebuy_confirmed') return 'Rebuy confirmation observed';
  if (event.kind === 'rebuy_scheduled') return 'Rebuy scheduled';
  return 'Account reconciled';
}

export function FundingHistory({ history }: { history: FundingHistoryState }) {
  return (
    <section className="funding-history" aria-label="Funding history">
      <h3>Funding history</h3>
      <p className="funding-history-note">
        Account activity is recorded separately from hand results.
      </p>
      {history.error && (
        <p role="status">Funding history refresh is delayed. Saved records remain visible.</p>
      )}
      {history.loading && !history.events.length ? (
        <p role="status">Loading funding history…</p>
      ) : !history.events.length ? (
        <p className="subtle">No funding events recorded yet.</p>
      ) : (
        <ol>
          {history.events.map((event) => (
            <li key={event.id}>
              <div className="funding-event-heading">
                <strong>{eventLabel(event)}</strong>
                <time dateTime={event.createdAt}>{time(event.createdAt)}</time>
              </div>
              <p>
                {event.kind === 'rebuy_confirmed' && event.amount !== null && (
                  <span>Rule amount: {number(event.amount)} chips · </span>
                )}
                {event.kind === 'rebuy_scheduled' && event.amount !== null && (
                  <span>{number(event.amount)} chips scheduled · </span>
                )}
                Account available {amount(event.availableBefore)} → {amount(event.availableAfter)}{' '}
                chips
              </p>
              {event.kind === 'rebuy_scheduled' && event.rebuyAvailableAt && (
                <p>
                  Expected window:{' '}
                  <time dateTime={event.rebuyAvailableAt}>{time(event.rebuyAvailableAt)}</time>
                </p>
              )}
              {event.chipsAtTable !== null && (
                <p>Account at table: {number(event.chipsAtTable)} chips</p>
              )}
              {event.kind === 'rebuy_confirmed' && event.availableAfter === null && (
                <p>Balance reconciliation pending.</p>
              )}
              <p className="funding-event-source">
                {event.source === 'ws'
                  ? 'Arena event'
                  : event.source === 'rest'
                    ? 'Account API'
                    : 'Account reconciliation'}{' '}
                · Run <span title={event.runId}>{event.runId.slice(0, 12)}</span>
              </p>
            </li>
          ))}
        </ol>
      )}
      {(history.hasMore || history.error) && (
        <button
          type="button"
          className="button compact secondary"
          disabled={history.loading}
          onClick={history.loadMore}
        >
          {history.loading
            ? 'Loading records…'
            : history.error
              ? 'Retry funding history'
              : 'Load older funding events'}
        </button>
      )}
    </section>
  );
}
