import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { publicRuntime } from '../src/server/spectator.js';
import { OpenPokerClient } from '../src/openpoker/client.js';
import { Store } from '../src/storage/store.js';
import type { FundingEventView, FundingView } from '../src/shared/api.js';

describe('public account funding records', () => {
  it('reads durable funding history with stable pagination and never invokes account operations', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(
      { ...loadConfig({}, true), publicHistory: true, apiToken: 'funding-test-admin-token' },
      { store },
    );
    const seasonRead = vi.spyOn(OpenPokerClient.prototype, 'seasonBalance');
    const rebuy = vi.spyOn(OpenPokerClient.prototype, 'rebuy');
    try {
      const profitBefore = store.db
        .prepare('SELECT SUM(profit) AS n FROM hands WHERE run_id=?')
        .get('demo-jev')?.n;
      const record: FundingEventView = {
        id: 'first',
        runId: 'demo-jev',
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'rebuy_confirmed',
        source: 'ws',
        amount: 1500,
        availableBefore: null,
        availableAfter: 1500,
        chipsAtTable: 0,
        rebuyAvailableAt: null,
      };
      store.saveFundingEvent(record);
      store.saveFundingEvent({
        ...record,
        id: 'second',
        createdAt: '2026-01-01T00:00:01.000Z',
        kind: 'balance_sync',
        source: 'reconciliation',
        amount: null,
        availableBefore: 1500,
        availableAfter: 0,
        chipsAtTable: 1500,
      });
      const first = await app.inject('/api/funding/events?limit=1');
      expect(first.statusCode).toBe(200);
      expect(first.json<FundingEventView[]>()).toMatchObject([
        { id: 'second', kind: 'balance_sync', amount: null },
      ]);
      const second = await app.inject('/api/funding/events?limit=1&before=second');
      expect(second.json<FundingEventView[]>()).toEqual([record]);
      expect((await app.inject('/api/funding/events?before=missing')).json()).toEqual([]);
      expect((await app.inject('/api/funding/events?limit=501')).statusCode).toBe(400);
      expect((await app.inject('/api/funding/events?limit=0')).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/runtime/stop' })).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            url: '/api/funding/events',
            headers: { authorization: 'Bearer invalid' },
          })
        ).statusCode,
      ).toBe(401);
      expect(seasonRead).not.toHaveBeenCalled();
      expect(rebuy).not.toHaveBeenCalled();
      expect(
        store.db.prepare('SELECT SUM(profit) AS n FROM hands WHERE run_id=?').get('demo-jev')?.n,
      ).toBe(profitBefore);
    } finally {
      seasonRead.mockRestore();
      rebuy.mockRestore();
      await app.close();
      store.close();
    }
  });

  it('publishes only the approved funding fields', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(loadConfig({}, true), { store });
    try {
      const funding: FundingView & { apiKey: string; paymentBalance: number } = {
        availableChips: 945,
        chipsAtTable: 473,
        autoRebuy: true,
        rebuyAmount: 1500,
        rebuyCooldownSeconds: 300,
        rebuyAvailableAt: null,
        lastRebuyAt: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
        observedAt: '2026-01-01T00:00:00.000Z',
        status: 'current',
        apiKey: 'secret-funding-key',
        paymentBalance: 100,
      };
      const published = publicRuntime({ ...app.controller.view(), funding });
      expect(published.funding?.availableChips).toBe(945);
      expect(published.funding?.chipsAtTable).toBe(473);
      expect(JSON.stringify(published)).not.toMatch(/secret-funding-key|paymentBalance|apiKey/);
    } finally {
      await app.close();
      store.close();
    }
  });
});
