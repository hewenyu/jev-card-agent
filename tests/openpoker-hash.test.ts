import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseEvent,
  serializeEvent,
  verifyStateHash,
  type ServerEvent,
} from '../src/openpoker/protocol.js';
import { Store } from '../src/storage/store.js';

// A fabricated six-seat snapshot with Python-generated hashes and numeric tokens.
// .txt keeps formatters/JSON importers from erasing 5.0 before parseEvent sees it.
const wire = readFileSync(
  new URL('./fixtures/openpoker-python-floats.json.txt', import.meta.url),
  'utf8',
);
const snapshotOf = (event: ServerEvent) => event.snapshot as ServerEvent;

describe('Python numeric representation in OpenPoker state hashes', () => {
  it('verifies the envelope, nested resync snapshot and replay while retaining normal numbers', () => {
    const event = parseEvent(wire);
    const snapshot = snapshotOf(event);
    const details = snapshot.waiting_details as Record<string, unknown>;
    expect(details.configured_delay_seconds).toBe(5);
    expect(typeof details.configured_delay_seconds).toBe('number');
    expect(verifyStateHash(event)).toBe(true);
    expect(verifyStateHash(snapshot)).toBe(true);
    expect(verifyStateHash((event.replayed_events as ServerEvent[])[0]!)).toBe(true);
    // Reproduce the previous lossy parse/stringify failure without guessing field types.
    expect(verifyStateHash(parseEvent(JSON.stringify(snapshot)))).toBe(false);
  });

  it('transfers root numeric tokens through schema validation and preserves array elements', () => {
    const event = parseEvent(
      '{"type":"table_state","duration":5.0,"values":[1.0,-0.0,1e-07],"nested":{"zero":0.0},"state_hash":"sha256:8b01abd229325721a3e94ccd2684b1cd45ff379addd4b2b33b25e79b6dadf416"}',
    );
    const serialized = serializeEvent(event);
    expect(verifyStateHash(event)).toBe(true);
    expect(serialized).toContain('"duration":5.0');
    expect(serialized).toContain('"values":[1.0,-0.0,1e-07]');
    expect(serialized).toContain('"nested":{"zero":0.0}');
    expect(Object.is((event.values as number[])[1], -0)).toBe(true);
    expect(Object.keys(event).sort()).toEqual([
      'duration',
      'nested',
      'state_hash',
      'type',
      'values',
    ]);
  });

  it('rejects nested numeric and root mutations instead of masking them with old source tokens', () => {
    const event = parseEvent(wire);
    const snapshot = snapshotOf(event);
    (snapshot.waiting_details as Record<string, unknown>).configured_delay_seconds = 6;
    expect(serializeEvent(snapshot)).toContain('"configured_delay_seconds":6');
    expect(verifyStateHash(snapshot)).toBe(false);
    expect(verifyStateHash(event)).toBe(false);
    const root = parseEvent('{"type":"table_state","value":5.0,"array":[-0.0]}');
    root.value = 6;
    (root.array as number[])[0] = 0;
    expect(serializeEvent(root)).toContain('"value":6');
    expect(serializeEvent(root)).toContain('"array":[0]');
  });

  it('persists original numeric representations for envelope and independently stored replay events', () => {
    const store = new Store(':memory:');
    try {
      store.beginRun({
        id: 'test-run',
        kind: 'live',
        strategy: 'baseline',
        startedAt: '2025-01-01T00:00:00Z',
        config: {},
      });
      const event = parseEvent(wire);
      store.appendEvent('test-run', event, '2025-01-01T00:00:01Z');
      store.appendEvent(
        'test-run',
        (event.replayed_events as ServerEvent[])[0]!,
        '2025-01-01T00:00:01Z',
      );
      const rows = store.db.prepare('SELECT payload FROM events ORDER BY id').all();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(String(row.payload)).toContain('"configured_delay_seconds":5.0');
        const reloaded = parseEvent(String(row.payload));
        expect(verifyStateHash(reloaded)).toBe(true);
        if (reloaded.type === 'resync_response')
          expect(verifyStateHash(snapshotOf(reloaded))).toBe(true);
      }
    } finally {
      store.close();
    }
  });
});
