import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import type { ChipMovement } from '../../../src/shared/api';
import { number } from '../api';
import './chip-motion.css';

export function ChipFlight({
  movement,
  scene,
}: {
  movement: ChipMovement;
  scene: RefObject<HTMLDivElement | null>;
}) {
  const [path, setPath] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const root = scene.current;
    const seat = root?.querySelector(`[data-seat="${movement.seat}"] .seat-info`);
    const pot = root?.querySelector('.pot');
    if (!root || !seat || !pot) return;
    const measure = () => {
      const container = root.getBoundingClientRect();
      const seatBox = seat.getBoundingClientRect();
      const potBox = pot.getBoundingClientRect();
      const player = { x: seatBox.left + seatBox.width / 2, y: seatBox.top + seatBox.height / 2 };
      const middle = { x: potBox.left + potBox.width / 2, y: potBox.top + potBox.height / 2 };
      const [from, to] = movement.direction === 'to-pot' ? [player, middle] : [middle, player];
      setPath({
        '--from-x': `${from.x - container.left}px`,
        '--from-y': `${from.y - container.top}px`,
        '--mid-x': `${(from.x + to.x) / 2 - container.left}px`,
        '--mid-y': `${(from.y + to.y) / 2 - container.top - 18}px`,
        '--to-x': `${to.x - container.left}px`,
        '--to-y': `${to.y - container.top}px`,
      } as CSSProperties);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [movement, scene]);
  if (!path) return null;
  return (
    <div
      className={`chip-flight chip-flight-${movement.direction}`}
      style={path}
      data-movement-id={movement.id}
      data-direction={movement.direction}
      role="status"
      aria-label={`${number(movement.amount)} chips ${movement.direction === 'to-pot' ? `from seat ${movement.seat + 1} to pot` : `from pot to seat ${movement.seat + 1}`}`}
    >
      <span className="flying-chips" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="chip-flight-amount">{number(movement.amount)}</span>
    </div>
  );
}
