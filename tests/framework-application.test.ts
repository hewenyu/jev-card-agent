import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';
import { prepareEvaluationProtocols } from '../src/cli/evaluation-protocols.js';

describe('framework-only production assembly', () => {
  it('exposes public read-only framework state, rejects legacy live strategies and records authenticated release controls without model calls', async () => {
    const store = new Store(':memory:');
    const config = loadConfig({
      PUBLIC_HISTORY: 'true',
      API_TOKEN: 'private-operator-token-for-tests',
      JEV_API_KEY: 'backend-only-model-key',
    });
    const app = await buildApp(config, { store });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await app.inject({ method: 'GET', url: '/api/framework' });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        engine: 'duelloop',
        research: { enabled: false, activationMode: 'automatic_after_validation' },
      });
      expect(result.body).not.toContain('backend-only');
      expect(result.body).not.toContain('private-operator');
      const denied = await app.inject({
        method: 'POST',
        url: '/api/framework/activation/pause',
        payload: { paused: true, actor: 'operator', reason: 'review' },
      });
      expect(denied.statusCode).toBe(403);
      const headers = { authorization: `Bearer ${config.apiToken}` };
      const changed = await app.inject({
        method: 'POST',
        url: '/api/framework/activation/pause',
        headers,
        payload: { paused: true, actor: 'operator', reason: 'review' },
      });
      expect(changed.statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/api/framework' })).json().research
          .activationPaused,
      ).toBe(true);
      expect(
        store.db.prepare('SELECT actor,reason,status FROM framework_operator_audit').get(),
      ).toMatchObject({ actor: 'operator', reason: 'review', status: 'completed' });
      for (const strategy of ['baseline', 'jev-reasoning']) {
        const start = await app.inject({
          method: 'POST',
          url: '/api/runtime/start',
          headers,
          payload: { strategy },
        });
        expect(start.statusCode).toBe(400);
        expect(app.controller.runtime).toBeNull();
      }
      const raw = await app.inject({
        method: 'POST',
        url: '/api/framework/releases/approve',
        headers,
        payload: { releaseDigest: '0'.repeat(64), actor: 'operator', reason: 'missing candidate' },
      });
      expect(raw.statusCode).toBe(400);
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS n FROM framework_operator_audit WHERE status='failed'")
          .get()!.n,
      ).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(store.adviceSource).toBeUndefined();
    } finally {
      fetcher.mockRestore();
      await app.close();
      store.close();
    }
  });
  it('keeps facts and research controls distinct and rejects empty approval attribution', async () => {
    const store = new Store(':memory:');
    const config = loadConfig({});
    const app = await buildApp(config, { store });
    try {
      const command = vi
        .spyOn(app.controller.frameworkResearch, 'command')
        .mockResolvedValue(undefined);
      const facts = vi.spyOn(app.controller.research, 'stop');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/framework/research/pause',
            payload: { paused: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(command).toHaveBeenCalledWith({ type: 'pause', paused: true });
      expect(facts).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/framework/activation/pause',
            payload: { paused: true, actor: '', reason: '' },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
      store.close();
    }
  });
  it('rejects retired live config and symlink database aliasing while retaining explicit offline diagnosis', () => {
    for (const env of [
      { ASYNC_LLM_MODE: 'off' },
      { LLM_ADVICE_MAX_ITEMS: '3' },
      { REASONING_MODE: 'always' },
      { HYBRID_TIMEOUT_MS: '10000' },
    ])
      expect(() => loadConfig(env)).toThrow('Retired live configuration');
    expect(() => loadConfig({ BOT_STRATEGY: 'baseline' })).toThrow('offline-only');
    expect(
      loadConfig({ BOT_STRATEGY: 'baseline', REASONING_MODE: 'always' }, false, { offline: true })
        .botStrategy,
    ).toBe('baseline');
    expect(loadConfig({ FACTS_ENABLED: 'false' }).researchEnabled).toBe(false);
    expect(loadConfig({ FACTS_ENABLED: 'true', RESEARCH_ENABLED: 'false' }).researchEnabled).toBe(
      true,
    );
    const dir = mkdtempSync(join(tmpdir(), 'framework-path-'));
    try {
      const raw = join(dir, 'raw.sqlite');
      writeFileSync(raw, '');
      const alias = join(dir, 'alias.sqlite');
      symlinkSync(raw, alias);
      expect(() => loadConfig({ DATABASE_PATH: raw, DUELLOOP_DATABASE_PATH: alias })).toThrow(
        'symlink aliases',
      );
      expect(
        loadConfig({ DATABASE_PATH: raw, DUELLOOP_ACTOR_ID: 'account-123' }).duelloopScopeId,
      ).toContain('account-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('private immutable evaluation protocol preparation', () => {
  it('creates fresh independent seeds with private permissions and refuses overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'framework-protocol-'));
    const args = {
      output: dir,
      'min-samples': '3',
      'hands-per-seed': '6',
      'minimum-improvement': '1',
      'max-group-regression': '5',
      confidence: '.95',
      'max-latency-ms': '1000',
    };
    try {
      const output = prepareEvaluationProtocols(args);
      const dev = JSON.parse(readFileSync(output.development, 'utf8'));
      const final = JSON.parse(readFileSync(output.final, 'utf8'));
      expect(dev.seeds).toHaveLength(3);
      expect(final.seeds).toHaveLength(3);
      expect(dev.seeds.some((seed: number) => final.seeds.includes(seed))).toBe(false);
      expect(output).not.toHaveProperty('seeds');
      expect(statSync(output.final).mode & 0o777).toBe(0o600);
      expect(() => prepareEvaluationProtocols(args)).toThrow('EEXIST');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
