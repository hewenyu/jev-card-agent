import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInitialState, buildContext } from '../src/core/index.js';
import { JevProvider } from '../src/policies/jev.js';
import { LedgerMeter } from '../src/storage/provider-meter.js';
import { Store } from '../src/storage/store.js';
import { loadConfig } from '../src/server/config.js';
import { Controller } from '../src/server/controller.js';
import { listenAndStart } from '../src/server/startup.js';
import { buildApp } from '../src/server/app.js';
import { seedDemo } from '../src/storage/demo.js';
import type { DecisionRecord } from '../src/runtime/types.js';

const block = {
  runId: 'old-run',
  decisionId: 'failed-decision',
  reason: 'jev_cancelled',
  createdAt: '2026-09-21T00:00:00Z',
};
const context = buildContext(createInitialState());
const candidates = [{ id: 'check', action: 'check' as const, label: 'Check' }];
const response = () =>
  new Response(
    JSON.stringify({
      model: 'jev-1.13.0',
      usage: { input_tokens: 100, output_tokens: 0 },
      answers: {
        action: { type: 'choice', choice: 'check', confidence: 1, probabilities: { check: 1 } },
      },
    }),
  );

describe('model operation without local monetary limits', () => {
  it('calls Jev after large historical unknown charges and records another successful attempt', async () => {
    const store = new Store(':memory:');
    try {
      store.db
        .prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)')
        .run('historical', 'old', 1000e9, null, null, null, 'unknown', block.createdAt);
      const fetcher = vi.fn(async () => response());
      const provider = new JevProvider({
        apiKey: 'fixture',
        fetch: fetcher,
        meter: new LedgerMeter(store, 'new'),
      });
      const result = await provider.decide(context, candidates);
      expect(result.source).toBe('jev');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        store.db.prepare("SELECT status,reserved_nanos FROM usage WHERE id='historical'").get(),
      ).toMatchObject({ status: 'unknown', reserved_nanos: 1000e9 });
      expect(
        store.db.prepare("SELECT status,input_tokens FROM usage WHERE run_id='new'").get(),
      ).toMatchObject({ status: 'settled', input_tokens: 100 });
    } finally {
      store.close();
    }
  });

  it('allows a retry after a single-attempt timeout while the overall deadline remains open', async () => {
    let calls = 0;
    const provider = new JevProvider({
      apiKey: 'fixture',
      timeoutMs: 20,
      fetch: async (_url, init) => {
        if (++calls > 1) return response();
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        });
      },
    });
    const result = await provider.decide(context, candidates, {
      signal: AbortSignal.timeout(1000),
    });
    expect(calls).toBe(2);
    expect(result.attempts?.map((attempt) => attempt.retryIndex)).toEqual([0, 1]);
    expect(result.attempts?.map((attempt) => attempt.status)).toEqual(['cancelled', 'succeeded']);
    const config = loadConfig({ TOTAL_BUDGET_USD: '0', RUN_BUDGET_USD: '0' });
    expect(config.jevTimeoutMs).toBe(10000);
    expect(config.jevDecisionTimeoutMs).toBe(40000);
    expect(config).not.toHaveProperty('totalBudgetUsd');
    expect(config).not.toHaveProperty('runBudgetUsd');
  });
});

describe('persisted model failure pause', () => {
  it('commits the failed decision and restart block together or rolls both back', () => {
    const store = new Store(':memory:');
    seedDemo(store);
    const decision: DecisionRecord = {
      id: block.decisionId,
      runId: 'demo-jev',
      handId: 'demo-jev-hand-1',
      createdAt: block.createdAt,
      status: 'failed',
      context,
      candidates,
      proposal: {
        source: 'unavailable',
        candidateId: '',
        selected: '',
        explanation: 'No model action available',
        latencyMs: 10,
      },
      fallbackReason: block.reason,
    };
    try {
      store.db.exec(`CREATE TRIGGER reject_block BEFORE INSERT ON meta
        WHEN NEW.key='decision_block' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END`);
      expect(() => store.saveDecision(decision)).toThrow('fixture disk failure');
      expect(
        store.db.prepare('SELECT id FROM decisions WHERE id=?').get(decision.id),
      ).toBeUndefined();
      expect(store.loadDecisionBlock()).toBeNull();
      store.db.exec('DROP TRIGGER reject_block');
      store.saveDecision(decision);
      expect(
        store.db.prepare('SELECT status FROM decisions WHERE id=?').get(decision.id)?.status,
      ).toBe('failed');
      expect(store.loadDecisionBlock()).toEqual({ ...block, runId: decision.runId });
    } finally {
      store.close();
    }
  });

  it('survives reopening the database and keeps HTTP available without automatic play', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-block-'));
    let store = new Store(join(dir, 'data.sqlite'));
    store.saveDecisionBlock(block);
    store.close();
    store = new Store(join(dir, 'data.sqlite'));
    const config = loadConfig({ AUTO_START_BOT: 'true' });
    const controller = new Controller(config, store);
    const start = vi.spyOn(controller, 'start');
    const app = {
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      controller,
    };
    try {
      expect(store.loadDecisionBlock()).toEqual(block);
      await listenAndStart(app, config);
      expect(app.listen).toHaveBeenCalledTimes(1);
      expect(app.close).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(controller.view()).toMatchObject({
        running: false,
        status: 'stopped',
        runId: block.runId,
        error: expect.stringContaining('bot paused'),
      });
      await expect(
        controller.start({
          strategy: 'jev',
          buyIn: 2000,
          maxHands: 0,
          maxMinutes: 0,
          autoRebuy: true,
        }),
      ).rejects.toThrow('private resume');
    } finally {
      await controller.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only explicit resume clears the block and restores it if startup fails', async () => {
    const store = new Store(':memory:');
    store.saveDecisionBlock(block);
    const controller = new Controller(loadConfig({}), store);
    try {
      const start = vi.spyOn(controller, 'start').mockImplementation(async () => {
        expect(store.loadDecisionBlock()).toBeNull();
        throw new Error('provider still unavailable');
      });
      await expect(controller.resume()).rejects.toThrow('provider still unavailable');
      expect(store.loadDecisionBlock()).toEqual(block);
      start.mockResolvedValue({ ...controller.view(), running: true, status: 'connecting' });
      await controller.resume();
      expect(store.loadDecisionBlock()).toBeNull();
    } finally {
      await controller.close();
      store.close();
    }
  });

  it('does not expose resume to public spectators', async () => {
    const token = 'fixture-private-admin-token-000';
    const app = await buildApp(
      loadConfig({ PUBLIC_HISTORY: 'true', API_TOKEN: token, DATABASE_PATH: ':memory:' }),
      { store: new Store(':memory:') },
    );
    const resume = vi.spyOn(app.controller, 'resume').mockResolvedValue(app.controller.view());
    try {
      expect((await app.inject({ method: 'POST', url: '/api/runtime/resume' })).statusCode).toBe(
        403,
      );
      expect(resume).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/runtime/resume',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(resume).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
