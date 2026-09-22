import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard } from '../../src/shared/api';
import { api, message } from './api';

/** One request supplies the selected view; stale selections cannot replace newer results. */
export function useDashboard(view: string, runId: string) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const current = generation.current;
    const started = performance.now();
    try {
      const query = new URLSearchParams({ view });
      if (runId) query.set('runId', runId);
      const value = await api<Dashboard>(`/dashboard?${query}`, controller.current?.signal);
      if (current !== generation.current) return;
      const selectedRun =
        runId ||
        value.overview.runs.find((run) => run.id === value.overview.runtime.runId)?.id ||
        value.overview.runs[0]?.id;
      setData((previous) => ({
        ...value,
        performance: value.performanceError
          ? previous?.performance && previous.performance.runId === selectedRun
            ? previous.performance
            : null
          : value.performance,
      }));
      setStartedAt(started);
      setRevision((value) => value + 1);
      setError(null);
    } catch (reason) {
      if (current === generation.current) setError(message(reason));
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [view, runId]);
  useEffect(() => {
    const current = ++generation.current;
    busy.current = false;
    const requestController = new AbortController();
    controller.current = requestController;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      generation.current = current + 1;
      requestController.abort();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  return { data, error, loading, revision, startedAt, refresh };
}
