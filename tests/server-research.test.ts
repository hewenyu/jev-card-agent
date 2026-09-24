import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { AdviceStore } from '../src/knowledge/advice-store.js';
import { publishFixture } from './helpers/research-fixture.js';

describe('anonymous research observations', () => {
  it('exposes approved summaries and explicit mode without raw evidence or mutation access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-research-public-'));
    const config = loadConfig({
      DATABASE_PATH: join(dir, 'raw.sqlite'),
      FACTS_ENABLED: 'false',
      PUBLIC_HISTORY: 'true',
      API_TOKEN: 'private-test-token-only-123456789',
      DUELLOOP_RESEARCH_API_KEY: 'private-provider-key-test',
    });
    const app = await buildApp(config);
    try {
      const advice = new AdviceStore(config.asyncLlm.databasePath);
      const { publication } = publishFixture(advice);
      advice.close();
      await app.controller.restartResearch();
      const result = await app.inject({ method: 'GET', url: '/api/research' });
      expect(result.statusCode).toBe(200);
      expect(result.json().legacy).toBe(true);
      expect(result.json().status.mode).toBe('off');
      expect(result.json().publications[0].guidance).toBe(publication.guidance);
      const framework = await app.inject({ method: 'GET', url: '/api/framework' });
      expect(framework.statusCode).toBe(200);
      expect(framework.json()).toMatchObject({
        engine: 'duelloop',
        research: { enabled: false, activationMode: 'explicit' },
      });
      for (const forbidden of [
        'private-provider-key-test',
        'private-test-token-only',
        'sampleDefinition',
        'inputSchemaVersion',
        'passedScenarios',
        'controlled-test',
        'evidence-hand',
      ])
        expect(`${result.body}\n${framework.body}`).not.toContain(forbidden);
      for (const route of ['pause', 'restart', 'approve', 'publish', 'withdraw', 'resume']) {
        const denied = await app.inject({ method: 'POST', url: `/api/research/${route}` });
        expect([403, 404]).toContain(denied.statusCode);
      }
      for (const route of [
        'research/pause',
        'research/cancel',
        'research/recover',
        'activation/pause',
        'releases/approve',
        'releases/rollback',
      ]) {
        const denied = await app.inject({ method: 'POST', url: `/api/framework/${route}` });
        expect(denied.statusCode).toBe(403);
      }
      expect(app.controller.runtime).toBeNull();
      const privatePause = await app.inject({
        method: 'POST',
        url: '/api/research/pause',
        headers: { authorization: `Bearer ${config.apiToken}` },
      });
      expect(privatePause.statusCode).toBe(200);
      expect(privatePause.json()).toEqual({ paused: true, maintenance: true });
      expect(app.controller.runtime).toBeNull();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
