import { useRef } from 'react';
import type { SpectatorEvent, TableView } from '../../../src/shared/api';
import { number } from '../api';
import { Cards } from './UI';
import { useChipMotion } from './chip-motion';
import { ChipFlight } from './ChipFlight';

export function PokerTable({
  table,
  label = 'TABLE VIEW',
  animated = false,
  events,
  motionEpoch,
}: {
  table: (TableView & { potKnown?: boolean }) | null;
  label?: string;
  animated?: boolean;
  events?: SpectatorEvent[];
  motionEpoch?: string;
}) {
  const scene = useRef<HTMLDivElement>(null);
  const motion = useChipMotion(table, animated, events, motionEpoch);
  return (
    <div className="poker-scene" ref={scene}>
      <div className="poker-felt">
        <div className="felt-ring" />
        <div className="table-center">
          <p className="table-label">{label}</p>
          <div className="pot">
            <span>POT</span>
            <strong
              key={animated ? table?.pot : undefined}
              className={animated ? 'amount-updated' : undefined}
            >
              {!table || table.potKnown === false ? '—' : number(table.pot)}
            </strong>
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
        const acting = animated && !table?.complete && table?.actorSeat === seat;
        const feedback = motion.feedback[seat];
        return (
          <div
            key={seat}
            data-seat={seat}
            className={`seat seat-${seat} ${hero ? 'seat-hero' : ''} ${player?.folded ? 'seat-folded' : ''} ${acting ? 'seat-current' : ''}`}
          >
            <div className="seat-avatar">
              {player ? (hero ? 'J' : player.name.charAt(0).toUpperCase()) : '·'}
              {table?.dealerSeat === seat && <span className="dealer">D</span>}
            </div>
            <div className="seat-info">
              <span>
                {player?.name ?? `Seat ${seat + 1}`}
                {hero && <em>{animated ? 'JEV' : 'YOU'}</em>}
              </span>
              <strong
                key={animated ? player?.stack : undefined}
                className={animated ? 'amount-updated' : undefined}
              >
                {player ? number(player.stack) : '—'}
              </strong>
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
            {animated && (acting || feedback) && (
              <span className="seat-action" key={acting ? 'acting' : feedback?.id}>
                {acting ? 'Acting' : feedback?.text}
              </span>
            )}
          </div>
        );
      })}
      {motion.active && (
        <ChipFlight key={motion.active.id} movement={motion.active} scene={scene} />
      )}
      <span className="table-street">{table?.street ?? 'Waiting for a table'}</span>
    </div>
  );
}
