import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const example = parseEnv(readFileSync('.env.example', 'utf8'));

describe('published environment example', () => {
  it('boots the live application configuration without retired settings or credentials', () => {
    const config = loadConfig(example);
    expect(config).toMatchObject({
      botStrategy: 'jev',
      autoStartBot: false,
      publicHistory: false,
      researchEnabled: true,
      openPokerApiKey: '',
      jevApiKey: '',
      duelloopActorId: 'openpoker-self',
      duelloopResearch: {
        enabled: false,
        provider: {
          apiKey: '',
          model: 'deepseek-flash',
          thinking: 'disabled',
          effort: 'high',
          maxRetries: 3,
        },
        jev: { apiKey: '', model: 'jev-1.13.0' },
      },
    });
    const paths = [
      config.databasePath,
      config.factsDatabasePath,
      config.duelloopDatabasePath,
      config.knowledgeDatabasePath,
      config.asyncLlm.databasePath,
    ];
    expect(new Set(paths).size).toBe(paths.length);
    expect(config.duelloopResearch.developmentProtocolPath).not.toBe(
      config.duelloopResearch.finalProtocolPath,
    );
  });

  it('supports explicitly enabling public reads and SDK research with private credentials', () => {
    const config = loadConfig({
      ...example,
      HOST: '0.0.0.0',
      PUBLIC_HISTORY: 'true',
      API_TOKEN: 'test-management-token-at-least-24-characters',
      JEV_API_KEY: 'test-jev-key',
      DUELLOOP_RESEARCH_API_KEY: 'test-research-key',
      DUELLOOP_RESEARCH_ENABLED: 'true',
    });
    expect(config.publicHistory).toBe(true);
    expect(config.duelloopResearch.enabled).toBe(true);
    expect(config.duelloopResearch.provider.apiKey).toBe('test-research-key');
    expect(config.duelloopResearch.jev.apiKey).toBe('test-jev-key');
    expect(config.duelloopResearch.provider.baseUrl).toBe('https://api.deepseek.com/anthropic');
  });
});
