import type { TableView } from '../../../src/shared/api';
import { number } from '../api';
import { Cards } from './UI';

export function PokerTable({
  table,
  label = 'TABLE VIEW',
}: {
  table: (TableView & { potKnown?: boolean }) | null;
  label?: string;
}) {
  return (
    <div className="poker-scene">
      <div className="poker-felt">
        <div className="felt-ring" />
        <div className="table-center">
          <p className="table-label">{label}</p>
          <div className="pot">
            <span>POT</span>
            <strong>{!table || table.potKnown === false ? '—' : number(table.pot)}</strong>
            <small>chips</small>
          </div>
          <Cards cards={table?.board ?? []} placeholders={5} />
          <div className="table-wordmark">
            JEV <span>♠</span> OPENPOKER
          </div>
        </div>
      </div>
      {Array.from({ length: 6 }, (_, seat) => {
        const player = table?.seats.find((item) => item.seat === seat);
        const hero = table?.heroSeat === seat;
        return (
          <div
            key={seat}
            className={`seat seat-${seat} ${hero ? 'seat-hero' : ''} ${player?.folded ? 'seat-folded' : ''}`}
          >
            <div className="seat-avatar">
              {player ? (hero ? 'J' : player.name.charAt(0).toUpperCase()) : '·'}
              {table?.dealerSeat === seat && <span className="dealer">D</span>}
            </div>
            <div className="seat-info">
              <span>
                {player?.name ?? `Seat ${seat + 1}`}
                {hero && <em>YOU</em>}
              </span>
              <strong>{player ? number(player.stack) : '—'}</strong>
            </div>
            {player && player.bet > 0 && (
              <span className="seat-bet">
                <i />
                {number(player.bet)}
              </span>
            )}
            {hero && table?.heroCards.length ? (
              <div className="hero-hole">
                <Cards cards={table.heroCards} size="small" />
              </div>
            ) : null}
          </div>
        );
      })}
      <span className="table-street">{table?.street ?? 'Waiting for a table'}</span>
    </div>
  );
}
