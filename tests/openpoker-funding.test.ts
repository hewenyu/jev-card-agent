import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenPokerClient } from '../src/openpoker/client.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const client = () =>
  new OpenPokerClient({ apiKey: 'test-key', restUrl: 'https://api.openpoker.ai' });

describe('authoritative season funding REST contracts', () => {
  it('uses virtual season balances and strips unrelated profile-like fields', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            chip_balance: 1500,
            chips_at_table: 0,
            pro_tier: true,
            auto_rebuy: true,
            score: 1250,
            season_id: 'season-current',
            balance: 99999,
            email: 'private',
          }),
        ),
    );
    const result = await client().seasonBalance(new AbortController().signal);
    expect(result).toEqual({
      chipBalance: 1500,
      chipsAtTable: 0,
      pro: true,
      autoRebuy: true,
      score: 1250,
      seasonId: 'season-current',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.openpoker.ai/api/season/me',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  it('preserves signed official scores and never invents a score when the field is absent', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            chip_balance: 400,
            chips_at_table: 1000,
            score: -50,
            season_id: 'season-next',
          }),
        ),
    );
    expect(await client().seasonBalance(new AbortController().signal)).toMatchObject({
      score: -50,
      seasonId: 'season-next',
    });
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ chip_balance: 400, chips_at_table: 1000 })),
    );
    expect(await client().seasonBalance(new AbortController().signal)).toMatchObject({
      score: null,
      seasonId: null,
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ chip_balance: 400, chips_at_table: 1000, score: '1400' })),
    );
    await expect(client().seasonBalance(new AbortController().signal)).rejects.toThrow();
  });
  it('allows first-season registration and rejects malformed known-season balances', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await client().seasonBalance(new AbortController().signal)).toBeNull();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ balance: 2000 })));
    await expect(client().seasonBalance(new AbortController().signal)).rejects.toThrow();
  });
  it('obeys Retry-After without guessing a locally credited balance', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    );
    expect(await client().rebuy(new AbortController().signal)).toEqual({
      status: 'cooldown',
      retryAfterMs: 120000,
    });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ chip_balance: 1500 })));
    expect(await client().rebuy(new AbortController().signal)).toEqual({ status: 'confirmed' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.openpoker.ai/api/season/rebuy',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });
  it('treats racing auto-rebuy ineligibility as reconciliation, but surfaces forbidden rebuy', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 400 }));
    expect(await client().rebuy(new AbortController().signal)).toEqual({ status: 'not_eligible' });
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(client().rebuy(new AbortController().signal)).rejects.toThrow(
      'verify account email',
    );
  });
});
