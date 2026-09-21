import { useCallback, useEffect, useRef, useState } from 'react';
import type { FundingEventView } from '../../src/shared/api';
import { api } from './api';

export interface FundingHistoryState {
  events: FundingEventView[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  loadMore: () => void;
}
const PAGE_SIZE = 8;

/** One app-level reader for Live funding history, retained across view switches. */
export function useFundingHistory(): FundingHistoryState {
  const [state, setState] = useState<Omit<FundingHistoryState, 'loadMore'>>({
    events: [],
    loading: true,
    error: false,
    hasMore: false,
  });
  const generation = useRef(0);
  const pending = useRef(false);
  const cursor = useRef<string | null>(null);
  const initialized = useRef(false);
  const knownIds = useRef(new Set<string>());
  const failedOlder = useRef(false);
  const refresh = useCallback(async (older = false) => {
    if (pending.current) return;
    pending.current = true;
    const currentGeneration = generation.current;
    const before = older ? cursor.current : null;
    if (older) setState((current) => ({ ...current, loading: true }));
    try {
      const events = await api<FundingEventView[]>(
        `/funding/events?limit=${PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      );
      if (!Array.isArray(events)) throw new Error('Invalid funding history');
      if (currentGeneration !== generation.current) return;
      const gap =
        initialized.current &&
        !older &&
        events.length === PAGE_SIZE &&
        !events.some((event) => knownIds.current.has(event.id));
      const advance = older || !initialized.current || gap;
      if (advance) cursor.current = events.at(-1)?.id ?? before;
      initialized.current = true;
      events.forEach((event) => knownIds.current.add(event.id));
      setState((current) => {
        const merged = new Map(current.events.map((event) => [event.id, event]));
        events.forEach((event) => merged.set(event.id, event));
        return {
          events: [...merged.values()].sort(
            (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
          ),
          loading: false,
          error: false,
          hasMore: advance ? events.length === PAGE_SIZE : current.hasMore,
        };
      });
    } catch {
      if (currentGeneration === generation.current) {
        failedOlder.current = older;
        setState((current) => ({ ...current, loading: false, error: true }));
      }
    } finally {
      if (currentGeneration === generation.current) pending.current = false;
    }
  }, []);
  useEffect(() => {
    const currentGeneration = ++generation.current;
    pending.current = false;
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      generation.current = currentGeneration + 1;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  return {
    ...state,
    loadMore: () => void refresh(state.error ? failedOlder.current : initialized.current),
  };
}
