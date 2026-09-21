import { useEffect, useState } from 'react';
import type { SpectatorSnapshot } from '../../src/shared/api';

export interface LiveSpectator {
  snapshot: SpectatorSnapshot | null;
  status: 'connecting' | 'live' | 'reconnecting';
  motionEpoch: string;
  receivedAt: number;
}

export function useLiveSpectator(): LiveSpectator {
  const [live, setLive] = useState<LiveSpectator>({
    snapshot: null,
    status: 'connecting',
    motionEpoch: '0',
    receivedAt: 0,
  });
  useEffect(() => {
    const stream = new EventSource('/api/live');
    let connection = 0;
    let sequence = -1;
    stream.onopen = () => {
      connection += 1;
      sequence = -1;
    };
    const snapshot = (event: MessageEvent<string>) => {
      try {
        const value = JSON.parse(event.data) as SpectatorSnapshot;
        if (
          !Number.isFinite(value.sequence) ||
          !value.runtime ||
          !Array.isArray(value.recentEvents)
        )
          return;
        if (value.sequence <= sequence) return;
        sequence = value.sequence;
        // Pair each connection's first snapshot with its epoch so old events never animate.
        setLive({
          snapshot: value,
          status: 'live',
          motionEpoch: String(connection),
          receivedAt: performance.now(),
        });
      } catch {
        // A malformed frame must not replace the most recent valid table.
      }
    };
    stream.addEventListener('snapshot', snapshot);
    stream.onerror = () => setLive((current) => ({ ...current, status: 'reconnecting' }));
    return () => {
      stream.removeEventListener('snapshot', snapshot);
      stream.close();
    };
  }, []);
  return live;
}
