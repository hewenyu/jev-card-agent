import { useEffect, useState } from 'react';
import type { RuntimeView } from '../../../src/shared/api';
import { number } from '../api';
import { Panel } from './UI';
import { FundingHistory } from './FundingHistory';
import type { FundingHistoryState } from '../funding-history';
import './account-funding.css';
import { fundingIsStale } from '../season-score';

function dateLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not yet reported';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function cooldownLabel(until: string | null | undefined, now: number): string {
  const deadline = until ? Date.parse(until) : NaN;
  if (!Number.isFinite(deadline)) return 'Not reported';
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  if (!remaining) return 'Window elapsed · awaiting confirmation';
  return `${Math.floor(remaining / 60)}m ${String(remaining % 60).padStart(2, '0')}s remaining`;
}

const chips = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? number(value) : '—';

export function AccountFunding({
  runtime,
  history,
}: {
  runtime: RuntimeView;
  history: FundingHistoryState;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const funding = runtime.funding;
  const hero = runtime.table?.seats.find((seat) => seat.seat === runtime.table?.heroSeat);
  const loading = !funding || funding.status === 'loading';
  const stale = fundingIsStale(funding, now);
  const status =
    runtime.mode === 'demo'
      ? 'Synthetic demo'
      : loading
        ? 'Loading account'
        : stale
          ? 'Account data stale'
          : 'Account current';
  return (
    <Panel
      title="Account & table chips"
      eyebrow="CURRENT ACCOUNT"
      className="account-funding"
      action={
        <span className={`funding-status ${stale ? 'stale' : ''}`} role="status">
          {status}
        </span>
      }
    >
      <div className="funding-body">
        <dl className="funding-balances">
          <div>
            <dt>
              Account available <small>CHIPS</small>
            </dt>
            <dd data-testid="account-available">{chips(funding?.availableChips)}</dd>
            <p>
              {stale
                ? 'Last confirmed available chips'
                : 'Off-table balance · ready for the next buy-in'}
            </p>
          </div>
          <div>
            <dt>
              Available to bet <small>CHIPS</small>
            </dt>
            <dd data-testid="seat-stack">{chips(hero?.stack)}</dd>
            <p>
              {hero
                ? runtime.mode === 'demo'
                  ? 'Synthetic table snapshot'
                  : 'Seat balance · excludes the current bet'
                : 'No current seat reported'}
            </p>
          </div>
          <div>
            <dt>
              Current street bet <small>CHIPS</small>
            </dt>
            <dd data-testid="seat-bet">{chips(hero?.bet)}</dd>
            <p>Already committed · included in the pot</p>
          </div>
          <div>
            <dt>
              Account at table <small>CHIPS</small>
            </dt>
            <dd data-testid="account-at-table">{chips(funding?.chipsAtTable)}</dd>
            <p>Official account snapshot · may lag live play</p>
          </div>
        </dl>
        <section className="funding-official-score" aria-label="Official season score">
          <div>
            <h3>Official season score</h3>
            <strong data-testid="live-season-score">{chips(funding?.seasonScore)}</strong>
          </div>
          <p>
            {funding?.seasonScore == null
              ? 'Not yet reported by OpenPoker.'
              : stale
                ? 'Last confirmed official score · refresh delayed.'
                : 'Reported by OpenPoker · separate from seat balance and current bet.'}
          </p>
          <p>
            Recorded{' '}
            <time dateTime={funding?.updatedAt ?? undefined}>{dateLabel(funding?.updatedAt)}</time>
            {funding?.seasonId && <> · Season {funding.seasonId}</>}
          </p>
        </section>
        <dl className="funding-details">
          <div>
            <dt>Automatic rebuy</dt>
            <dd>{funding ? (funding.autoRebuy ? 'On' : 'Off') : 'Unknown'}</dd>
          </div>
          <div>
            <dt>Rebuy amount</dt>
            <dd>{funding ? `+${number(funding.rebuyAmount)} chips` : '—'}</dd>
          </div>
          <div>
            <dt>Cooldown</dt>
            <dd>{funding ? `${number(funding.rebuyCooldownSeconds)} seconds` : '—'}</dd>
          </div>
          <div>
            <dt>Rebuy countdown</dt>
            <dd data-testid="rebuy-countdown">{cooldownLabel(funding?.rebuyAvailableAt, now)}</dd>
          </div>
          <div>
            <dt>Last observed rebuy</dt>
            <dd>
              <time dateTime={funding?.lastRebuyAt ?? undefined}>
                {dateLabel(funding?.lastRebuyAt)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Account updated</dt>
            <dd>
              <time dateTime={funding?.updatedAt ?? undefined}>
                {dateLabel(funding?.updatedAt)}
              </time>
            </dd>
          </div>
        </dl>
        {(loading || stale) && (
          <p className="funding-notice">
            {runtime.mode === 'demo'
              ? 'Account funding is unavailable in the synthetic demo.'
              : stale
                ? 'Account refresh is delayed. Any amounts shown are the last confirmed values; updates resume automatically.'
                : 'Waiting for the account snapshot. Balances appear when confirmed.'}
          </p>
        )}
        <FundingHistory history={history} />
      </div>
    </Panel>
  );
}
