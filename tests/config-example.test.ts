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
        activationMode: 'automatic_after_validation',
        provider: {
          apiKey: '',
          model: 'deepseek-flash',
          thinking: 'enabled',
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
      config.researchDatabasePath,
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

  it('reads legacy archives without parsing retired research model settings in offline mode', () => {
    const config = loadConfig(
      {
        DATABASE_PATH: 'data/archive-raw.sqlite',
        RESEARCH_DATABASE_PATH: 'data/archive-research.sqlite',
        LLM_RESEARCH_PROVIDER: 'retired-provider',
        LLM_RESEARCH_BASE_URL: 'invalid-retired-url',
        LLM_RESEARCH_TIMEOUT_MS: 'invalid',
      },
      false,
      { offline: true },
    );
    expect(config.researchDatabasePath).toMatch(/\/data\/archive-research.sqlite$/);
    expect(() =>
      loadConfig({ DATABASE_PATH: 'data/raw.sqlite', RESEARCH_DATABASE_PATH: 'data/raw.sqlite' }),
    ).toThrow('Research database must be separate');
    expect(() =>
      loadConfig({
        KNOWLEDGE_DATABASE_PATH: 'data/shared.sqlite',
        RESEARCH_DATABASE_PATH: 'data/shared.sqlite',
      }),
    ).toThrow('Research database must be separate');
  });
});
