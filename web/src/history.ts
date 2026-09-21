import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message } from './api';

interface HistoryItem {
  id: string;
  startedAt: string;
}
export function mergeHistory<T extends HistoryItem>(older: T[], newer: T[]): T[] {
  const items = new Map(older.map((item) => [item.id, item]));
  newer.forEach((item) => items.set(item.id, item));
  return [...items.values()].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  );
}

/** Fetch bounded pages; keep an independent oldest-page cursor while refreshing new records. */
export function useHistoryPages<T extends HistoryItem>(
  path: string | null,
  refreshKey?: string | number,
) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const generation = useRef(0);
  const cursor = useRef<string | null>(null);
  const busy = useRef(false);
  const initialized = useRef(false);
  const knownIds = useRef(new Set<string>());
  const cursorGeneration = useRef(0);

  const load = useCallback(
    async (append: boolean, refresh = false) => {
      if (!path || (busy.current && !refresh)) return;
      const requestGeneration = generation.current;
      const requestCursorGeneration = cursorGeneration.current;
      if (!refresh) {
        busy.current = true;
        setLoading(true);
      }
      setError(null);
      const before = append ? cursor.current : null;
      try {
        const page = await api<T[]>(
          `${path}${path.includes('?') ? '&' : '?'}limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        );
        if (requestGeneration !== generation.current) return;
        if (append && requestCursorGeneration !== cursorGeneration.current) return;
        // A suspended tab may miss more than a page of new hands. Traverse that gap before
        // continuing the old cursor, while retaining already loaded records for replay.
        const missedPage =
          refresh &&
          initialized.current &&
          page.length === 100 &&
          !page.some((item) => knownIds.current.has(item.id));
        page.forEach((item) => knownIds.current.add(item.id));
        setItems((current) => mergeHistory(current, page));
        if (!refresh || !initialized.current || missedPage) {
          if (missedPage) cursorGeneration.current++;
          cursor.current = page.at(-1)?.id ?? before;
          setHasMore(page.length === 100);
        }
        initialized.current = true;
      } catch (reason) {
        if (requestGeneration === generation.current) setError(message(reason));
      } finally {
        if (requestGeneration === generation.current && !refresh) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [path],
  );

  useEffect(() => {
    const currentGeneration = ++generation.current;
    cursor.current = null;
    busy.current = false;
    initialized.current = false;
    knownIds.current = new Set();
    cursorGeneration.current++;
    setItems([]);
    setError(null);
    setHasMore(false);
    setLoadedPath(path);
    setLoading(false);
    void load(false);
    return () => {
      generation.current = currentGeneration + 1;
    };
  }, [path, load]);

  useEffect(() => {
    if (initialized.current) void load(false, true);
  }, [refreshKey, load]);

  return {
    items: loadedPath === path ? items : [],
    loading,
    error,
    hasMore,
    loadMore: () => load(initialized.current),
  };
}
