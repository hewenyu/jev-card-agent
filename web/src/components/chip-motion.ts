import { useEffect, useReducer, useState } from 'react';
import type { ChipMovement, SpectatorEvent, TableView } from '../../../src/shared/api';

const emptyEvents: SpectatorEvent[] = [];
export const CHIP_TRAVEL_MS = 950;
interface MotionState {
  scope: string;
  seen: Set<string>;
  queue: ChipMovement[];
  feedback: Record<number, { id: string; text: string }>;
}
type MotionAction =
  | { type: 'snapshot'; scope: string; events: SpectatorEvent[]; reduced: boolean }
  | { type: 'finished'; scope: string; id: string };
const initial: MotionState = { scope: '', seen: new Set(), queue: [], feedback: {} };

function reducer(state: MotionState, action: MotionAction): MotionState {
  if (action.type === 'finished') {
    if (state.scope !== action.scope || state.queue[0]?.id !== action.id) return state;
    return { ...state, queue: state.queue.slice(1) };
  }
  if (state.scope !== action.scope) {
    return {
      scope: action.scope,
      seen: new Set(
        action.events.flatMap((event) => [event.id, ...event.movements.map((m) => m.id)]),
      ),
      queue: [],
      feedback: {},
    };
  }
  const seen = new Set(state.seen);
  const queue = action.reduced ? [] : [...state.queue];
  const feedback = { ...state.feedback };
  for (const event of action.events) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      if (event.seat !== undefined && event.action) {
        feedback[event.seat] = { id: event.id, text: event.action.replaceAll('_', ' ') };
      }
    }
    for (const movement of event.movements) {
      if (seen.has(movement.id)) continue;
      seen.add(movement.id);
      if (!Number.isFinite(movement.amount) || movement.amount <= 0) continue;
      if (!Number.isInteger(movement.seat) || movement.seat < 0 || movement.seat > 5) continue;
      if (movement.direction === 'from-pot') {
        feedback[movement.seat] = { id: movement.id, text: 'awarded' };
      }
      if (!action.reduced) queue.push(movement);
    }
  }
  return { scope: state.scope, seen, queue, feedback };
}

export function useChipMotion(
  table: TableView | null,
  animated: boolean,
  events: SpectatorEvent[] = emptyEvents,
  epoch = '',
) {
  const [reduced, setReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [state, dispatch] = useReducer(reducer, initial);
  const scope = JSON.stringify([animated, epoch, table?.tableId, table?.handId]);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const visibleEvents = animated
      ? events
          .filter((event) => event.tableId === table?.tableId && event.handId === table?.handId)
          .map((event) => ({
            ...event,
            movements: event.movements.filter(
              (movement) =>
                movement.tableId === table?.tableId && movement.handId === table?.handId,
            ),
          }))
      : [];
    dispatch({ type: 'snapshot', scope, events: visibleEvents, reduced });
  }, [scope, animated, events, table?.tableId, table?.handId, reduced]);
  const active = animated && !reduced && state.scope === scope ? state.queue[0] : undefined;
  useEffect(() => {
    if (!active) return;
    const timeout = setTimeout(
      () => dispatch({ type: 'finished', scope, id: active.id }),
      CHIP_TRAVEL_MS,
    );
    return () => clearTimeout(timeout);
  }, [active, scope]);
  return { active, feedback: state.scope === scope ? state.feedback : {}, reduced };
}
