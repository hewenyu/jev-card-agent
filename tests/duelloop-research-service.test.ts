import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DuelLoop, SqliteStore } from 'duelloop';
import { createPokerDomain, POKER_DOMAIN_ID } from '../src/poker/domain.js';
import { createPokerStrategy } from '../src/poker/strategy.js';
import { createPokerPilotProtocols } from '../src/evaluation/poker/protocol.js';
import { createLiveModel } from '../src/duelloop/live/model.js';
import { parseDuelLoopResearchConfig } from '../src/duelloop/research/config.js';
import { DuelLoopResearchService } from '../src/duelloop/research/service.js';

async function until(test: () => boolean) {
  const deadline = Date.now() + 7000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('Worker status timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
describe('isolated SDK research worker', () => {
  it('waits for valid private evaluation protocols without starting a failing worker loop', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'duelloop-no-protocol-'));
    const config = parseDuelLoopResearchConfig({
      DUELLOOP_RESEARCH_ENABLED: 'true',
      DUELLOOP_RESEARCH_API_KEY: 'fixture',
      JEV_API_KEY: 'fixture',
      DUELLOOP_DEVELOPMENT_PROTOCOL: join(directory, 'missing-dev.json'),
      DUELLOOP_FINAL_PROTOCOL: join(directory, 'missing-final.json'),
    });
    const service = new DuelLoopResearchService(
      join(directory, 'framework.sqlite'),
      'scope',
      config,
    );
    try {
      await service.start();
      expect(service.status()).toMatchObject({ state: 'waiting_protocol', running: false });
      expect(service.status().error).toContain('Live decisions continue');
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('boots the real worker without starting arena/model calls and restores durable pause after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'duelloop-worker-'));
    const path = join(directory, 'framework.sqlite');
    const config = parseDuelLoopResearchConfig({
      DUELLOOP_RESEARCH_ENABLED: 'true',
      DUELLOOP_RESEARCH_API_KEY: 'fixture-never-sent',
      JEV_API_KEY: 'fixture-never-sent',
      DUELLOOP_RESEARCH_POLL_MS: '50',
      DUELLOOP_DEVELOPMENT_PROTOCOL: join(directory, 'development.json'),
      DUELLOOP_FINAL_PROTOCOL: join(directory, 'final.json'),
    });
    const protocols = createPokerPilotProtocols(POKER_DOMAIN_ID, 1000);
    writeFileSync(config.developmentProtocolPath, JSON.stringify(protocols.development));
    writeFileSync(config.finalProtocolPath, JSON.stringify(protocols.final));
    const store = new SqliteStore(path);
    const domain = createPokerDomain({
      observe: async () => {
        throw new Error('No live');
      },
      candidates: async () => [],
    });
    const runtime = new DuelLoop({
      applicationId: 'worker-test',
      domain,
      model: createLiveModel(config.jev, { onAttempt: () => {} }),
      store,
      mode: 'shadow',
      executionOwner: 'host',
      ...config.decisionPolicy,
    });
    runtime.bootstrap(createPokerStrategy(), 'worker-scope');
    store.close();
    const service = new DuelLoopResearchService(path, 'worker-scope', config);
    try {
      await service.start();
      await until(() => service.status().research?.state === 'idle');
      expect(service.status().research?.latestRuns).toHaveLength(0);
      expect(await service.command({ type: 'pause', paused: true })).toEqual({ paused: true });
      await service.stop();
      await service.start();
      await until(() => service.status().running && service.status().paused);
      expect(service.status().research?.latestRuns).toHaveLength(0);
      await service.command({ type: 'pause', paused: false });
      await until(() => !service.status().paused);
      expect(service.status().research?.activation.activationMode).toBe(
        'automatic_after_validation',
      );
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
