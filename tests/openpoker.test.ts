import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OpenPokerClient } from '../src/openpoker/client.js';
import { parseEvent, verifyStateHash } from '../src/openpoker/protocol.js';

describe('OpenPoker envelope validation and snapshot verification', () => {
  it('allows forward-compatible fields but rejects malformed envelopes', () => {
    expect(parseEvent('{"type":"future_event","table_seq":12,"new_value":true}').new_value).toBe(
      true,
    );
    expect(() => parseEvent('{"type":"table_state","table_seq":-2}')).toThrow();
    expect(() => parseEvent('{"type":null}')).toThrow();
    expect(() => parseEvent('not json')).toThrow();
  });
  it('preserves nullable idle-table metadata without inventing action authority', () => {
    const event = parseEvent(
      JSON.stringify({
        type: 'table_state',
        table_id: null,
        hand_id: null,
        table_seq: null,
        hand_seq: null,
        ts: null,
        actor_seat: null,
        waiting_reason: 'awaiting_hand_start',
      }),
    );
    expect(event.hand_id).toBeNull();
    expect(event.hand_seq).toBeNull();
    expect(event.table_id).toBeNull();
    expect(event.table_seq).toBeNull();
    expect(event.turn_token).toBeUndefined();
    const encoded = '{"hand_id":null,"type":"table_state"}';
    const hash = createHash('sha256').update(encoded).digest('hex');
    expect(
      verifyStateHash(
        parseEvent(
          JSON.stringify({ type: 'table_state', hand_id: null, state_hash: `sha256:${hash}` }),
        ),
      ),
    ).toBe(true);
  });

  it('hashes sorted keys and escaped Unicode without metadata', () => {
    const canonical = '{"hero":{"name":"\\u73a9\\u5bb6"},"type":"table_state"}';
    const digest = createHash('sha256').update(canonical).digest('hex');
    const event = {
      type: 'table_state',
      hero: { name: '玩家' },
      ts: '2026-09-20',
      table_seq: 200,
      state_hash: `sha256:${digest}`,
    };
    expect(verifyStateHash(event)).toBe(true);
    expect(verifyStateHash({ ...event, hero: { name: 'changed' } })).toBe(false);
  });
  it('accepts the real unseated REST shape with nullable table fields and refuses redirects', async () => {
    const original = globalThis.fetch;
    const mocked = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ playing: false, table_id: null, seat: null, stack_chips: null }),
          { status: 200 },
        ),
    );
    globalThis.fetch = mocked;
    try {
      const result = await new OpenPokerClient({ apiKey: 'mock-key' }).activeGame();
      expect(result.playing).toBe(false);
      expect(result.table_id).toBeUndefined();
      expect(mocked).toHaveBeenCalledWith(
        'https://api.openpoker.ai/api/me/active-game',
        expect.objectContaining({ redirect: 'error' }),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
