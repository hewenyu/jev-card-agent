import { resolve } from 'node:path';
import type { StrategyName } from '../shared/api.js';
import { loadAsyncResearchConfig, type AsyncResearchConfig } from '../research/config.js';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  knowledgeDatabasePath: string;
  researchEnabled: boolean;
  asyncLlm: AsyncResearchConfig;
  apiToken: string;
  demo: boolean;
  readOnlyDemo: boolean;
  publicHistory: boolean;
  staticRoot: string;
  openPokerApiKey: string;
  openPokerWsUrl: string;
  openPokerRestUrl: string;
  jevApiKey: string;
  jevBaseUrl: string;
  jevModel: string;
  jevTimeoutMs: number;
  jevDecisionTimeoutMs: number;
  reasoningApiKey: string;
  reasoningProvider: 'standard' | 'deepseek';
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekThinking: 'enabled' | 'disabled';
  reasoningBaseUrl: string;
  reasoningProtocol: 'responses' | 'messages';
  reasoningModel: string;
  reasoningMessagesModel: string;
  reasoningTimeoutMs: number;
  reasoningMode: 'always' | 'adaptive';
  reasoningEffort: 'low' | 'medium' | 'high' | 'max';
  reasoningMaxOutputTokens: number;
  hybridTimeoutMs: number;
  reasoningInputPricePerMillion: number;
  reasoningCacheReadInputPricePerMillion: number;
  reasoningOutputPricePerMillion: number;
  autoStartBot: boolean;
  botStrategy: StrategyName;
}
export const isLoopback = (host: string): boolean =>
  ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
function numeric(value: string | undefined, fallback: number, name: string, min = 0): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`Invalid ${name}`);
  return parsed;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env, demo = false): AppConfig {
  const readOnlyDemo = env.READ_ONLY_DEMO === 'true';
  const synthetic = demo || readOnlyDemo;
  const botStrategy = env.BOT_STRATEGY || 'jev';
  const reasoningMode = env.REASONING_MODE || 'always';
  const reasoningEffort = env.REASONING_EFFORT || 'high';
  const reasoningProvider = env.REASONING_PROVIDER || 'standard';
  if (!['standard', 'deepseek'].includes(reasoningProvider))
    throw new Error('REASONING_PROVIDER must be standard or deepseek');
  const deepseek = reasoningProvider === 'deepseek';
  const deepseekModel = env.DEEPSEEK_MODEL || 'deepseek-flash';
  const deepseekThinking = env.DEEPSEEK_THINKING || 'enabled';
  if (!['enabled', 'disabled'].includes(deepseekThinking))
    throw new Error('DEEPSEEK_THINKING must be enabled or disabled');
  if (deepseek && !['deepseek-flash', 'deepseek-v4-pro'].includes(deepseekModel))
    throw new Error('DEEPSEEK_MODEL must use an exact published model ID');
  const prices = deepseekModel === 'deepseek-v4-pro' ? [1.32, 0.044, 3.96] : [0.3, 0.006, 1.2];
  const inputPrice = numeric(
    deepseek ? env.DEEPSEEK_INPUT_PRICE_PER_MILLION : env.REASONING_INPUT_PRICE_PER_MILLION,
    deepseek ? prices[0]! : 10,
    deepseek ? 'DEEPSEEK_INPUT_PRICE_PER_MILLION' : 'REASONING_INPUT_PRICE_PER_MILLION',
  );
  if (!['always', 'adaptive'].includes(reasoningMode))
    throw new Error('REASONING_MODE must be always or adaptive');
  if (!['low', 'medium', 'high', ...(deepseek ? ['max'] : [])].includes(reasoningEffort))
    throw new Error('REASONING_EFFORT must be low, medium or high (max requires DeepSeek)');
  if (!['jev', 'baseline', 'jev-reasoning'].includes(botStrategy))
    throw new Error('BOT_STRATEGY must be jev, baseline or jev-reasoning');
  if (env.AUTO_START_BOT && !['true', 'false'].includes(env.AUTO_START_BOT))
    throw new Error('AUTO_START_BOT must be true or false');
  if (env.PUBLIC_HISTORY && !['true', 'false'].includes(env.PUBLIC_HISTORY))
    throw new Error('PUBLIC_HISTORY must be true or false');
  if (env.RESEARCH_ENABLED && !['true', 'false'].includes(env.RESEARCH_ENABLED))
    throw new Error('RESEARCH_ENABLED must be true or false');
  const databasePath = synthetic
    ? resolve(env.DEMO_DATABASE_PATH || env.DATABASE_PATH || 'data/demo.sqlite')
    : resolve(env.DATABASE_PATH || 'data/jev.sqlite');
  const knowledgeDatabasePath = resolve(
    env.KNOWLEDGE_DATABASE_PATH || `${databasePath}.knowledge.sqlite`,
  );
  if (knowledgeDatabasePath === databasePath)
    throw new Error('Knowledge database must be separate from the raw database');
  const config: AppConfig = {
    host: env.HOST || '127.0.0.1',
    port: numeric(env.PORT, 8787, 'PORT'),
    databasePath,
    knowledgeDatabasePath,
    researchEnabled: !synthetic && env.RESEARCH_ENABLED !== 'false',
    asyncLlm: loadAsyncResearchConfig(env, databasePath, synthetic),
    apiToken: env.API_TOKEN || '',
    demo: synthetic,
    readOnlyDemo,
    publicHistory: env.PUBLIC_HISTORY === 'true',
    staticRoot: resolve('dist/public'),
    openPokerApiKey: synthetic ? '' : env.OPEN_POKER_API_KEY || env.OPENPOKER_API_KEY || '',
    openPokerWsUrl: env.OPEN_POKER_WS_URL || env.OPENPOKER_WS_URL || 'wss://openpoker.ai/ws',
    openPokerRestUrl:
      env.OPEN_POKER_REST_BASE_URL || env.OPENPOKER_REST_URL || 'https://api.openpoker.ai',
    jevApiKey: synthetic ? '' : env.JEV_API_KEY || '',
    jevBaseUrl: env.JEV_BASE_URL || 'https://api.typesafe.ai',
    jevModel: env.JEV_MODEL || 'jev-1.13.0',
    jevTimeoutMs: numeric(env.JEV_TIMEOUT_MS, 10000, 'JEV_TIMEOUT_MS', 1),
    jevDecisionTimeoutMs: numeric(env.JEV_DECISION_TIMEOUT_MS, 40000, 'JEV_DECISION_TIMEOUT_MS', 1),
    reasoningApiKey: synthetic
      ? ''
      : (deepseek ? env.DEEPSEEK_API_KEY : env.REASONING_API_KEY) || '',
    reasoningProvider: reasoningProvider as AppConfig['reasoningProvider'],
    deepseekBaseUrl: env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com/anthropic',
    deepseekModel,
    deepseekThinking: deepseekThinking as AppConfig['deepseekThinking'],
    reasoningBaseUrl: env.REASONING_API_BASE_URL || 'https://api.openai.com/v1',
    reasoningProtocol:
      deepseek || env.REASONING_API_FORMAT === 'messages' ? 'messages' : 'responses',
    reasoningModel: env.REASONING_MODEL || 'gpt-6-astra',
    reasoningMessagesModel: env.REASONING_MESSAGES_MODEL || 'claude-opus-5',
    reasoningTimeoutMs: numeric(env.REASONING_TIMEOUT_MS, 10000, 'REASONING_TIMEOUT_MS', 1),
    reasoningMode: reasoningMode as AppConfig['reasoningMode'],
    reasoningEffort: reasoningEffort as AppConfig['reasoningEffort'],
    reasoningMaxOutputTokens: numeric(
      env.REASONING_MAX_OUTPUT_TOKENS,
      4096,
      'REASONING_MAX_OUTPUT_TOKENS',
      1,
    ),
    hybridTimeoutMs: numeric(env.HYBRID_TIMEOUT_MS, 15000, 'HYBRID_TIMEOUT_MS', 1),
    reasoningInputPricePerMillion: inputPrice,
    reasoningCacheReadInputPricePerMillion: deepseek
      ? numeric(
          env.DEEPSEEK_CACHE_READ_INPUT_PRICE_PER_MILLION,
          prices[1]!,
          'DEEPSEEK_CACHE_READ_INPUT_PRICE_PER_MILLION',
        )
      : inputPrice,
    reasoningOutputPricePerMillion: numeric(
      deepseek ? env.DEEPSEEK_OUTPUT_PRICE_PER_MILLION : env.REASONING_OUTPUT_PRICE_PER_MILLION,
      deepseek ? prices[2]! : 50,
      deepseek ? 'DEEPSEEK_OUTPUT_PRICE_PER_MILLION' : 'REASONING_OUTPUT_PRICE_PER_MILLION',
    ),
    autoStartBot: !synthetic && env.AUTO_START_BOT === 'true',
    botStrategy: botStrategy as StrategyName,
  };
  if (env.REASONING_API_FORMAT && !['responses', 'messages'].includes(env.REASONING_API_FORMAT))
    throw new Error('REASONING_API_FORMAT must be responses or messages');
  if (config.asyncLlm.databasePath === knowledgeDatabasePath)
    throw new Error('Research database must be separate from the statistics database');
  if (config.hybridTimeoutMs > 40_000)
    throw new Error('HYBRID_TIMEOUT_MS must leave submission time below the 45-second turn');
  if (config.jevDecisionTimeoutMs > 40_000 || config.jevTimeoutMs > config.jevDecisionTimeoutMs)
    throw new Error('Jev timeouts require a single attempt <= total decision time <= 40000ms');
  if (
    !Number.isSafeInteger(config.reasoningMaxOutputTokens) ||
    config.reasoningMaxOutputTokens > 32768
  )
    throw new Error('REASONING_MAX_OUTPUT_TOKENS must be an integer from 1 to 32768');
  if (!Number.isInteger(config.port) || config.port > 65535) throw new Error('Invalid PORT');
  if (!isLoopback(config.host) && !config.apiToken && !config.readOnlyDemo) {
    throw new Error('A non-loopback HOST requires API_TOKEN or READ_ONLY_DEMO=true');
  }
  if (config.apiToken && config.apiToken.length < 24)
    throw new Error('API_TOKEN must contain at least 24 characters');
  if (config.publicHistory && !config.apiToken && !config.readOnlyDemo)
    throw new Error('PUBLIC_HISTORY requires API_TOKEN for private queries and controls');
  return config;
}
