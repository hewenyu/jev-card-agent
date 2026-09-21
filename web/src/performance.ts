import { useCallback, useEffect, useRef, useState } from 'react';
import type { PerformanceView } from '../../src/shared/api';
import { api } from './api';

export function useRunPerformance(runId: string | undefined, revision: number) {
  const [result, setResult] = useState<PerformanceView | null>(null);
  const [failedRun, setFailedRun] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (!runId || busy.current) return;
    const current = generation.current;
    busy.current = true;
    try {
      const value = await api<PerformanceView>(`/runs/${encodeURIComponent(runId)}/performance`);
      if (current !== generation.current) return;
      if (value.runId !== runId) throw new Error('Unexpected statistics run');
      setResult(value);
      setFailedRun(null);
    } catch {
      if (current === generation.current) setFailedRun(runId);
    } finally {
      if (current === generation.current) busy.current = false;
    }
  }, [runId]);
  useEffect(() => {
    const currentGeneration = ++generation.current;
    busy.current = false;
    setResult(null);
    setFailedRun(null);
    void refresh();
    return () => {
      generation.current = currentGeneration + 1;
    };
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [revision, refresh]);
  return {
    data: result?.runId === runId ? result : null,
    error: failedRun === runId ? 'Statistics refresh is delayed.' : null,
  };
}
