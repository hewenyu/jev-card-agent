import { resolve } from 'node:path';
import { endpoint } from '../policies/metering.js';
export interface AsyncResearchConfig {
  mode: 'off' | 'shadow' | 'live';
  databasePath: string;
  publishPolicy: 'manual' | 'approved_recipe';
  maxItems: number;
  provider: 'deepseek' | 'standard';
  protocol: 'messages' | 'responses';
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking: 'enabled' | 'disabled';
  effort: 'low' | 'medium' | 'high' | 'max';
  maxOutputTokens: number;
  timeoutMs: number;
  jobTimeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  maxPending: number;
  initialMinHands?: number;
  minNewHands: number;
  leakMinNewHands: number;
  intervalMs: number;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cacheReadPricePerMillion: number | null;
  cacheCreationPricePerMillion: number | null;
}
function choice<T extends string>(
  value: string | undefined,
  fallback: T,
  values: T[],
  name: string,
): T {
  const selected = value || fallback;
  if (!values.includes(selected as T)) throw new Error(`Invalid ${name}`);
  return selected as T;
}
function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name] ? Number(env[name]) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
function price(env: NodeJS.ProcessEnv, name: string): number | null {
  if (!env[name]) return null;
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
export function loadAsyncResearchConfig(
  env: NodeJS.ProcessEnv,
  rawPath: string,
  synthetic = false,
): AsyncResearchConfig {
  const mode = choice(env.ASYNC_LLM_MODE, 'off', ['off', 'shadow', 'live'], 'ASYNC_LLM_MODE');
  const provider = choice(
    env.LLM_RESEARCH_PROVIDER,
    'deepseek',
    ['deepseek', 'standard'],
    'LLM_RESEARCH_PROVIDER',
  );
  const config: AsyncResearchConfig = {
    mode: synthetic ? 'off' : mode,
    databasePath: resolve(env.RESEARCH_DATABASE_PATH || `${rawPath}.research.sqlite`),
    publishPolicy: choice(
      env.LLM_ADVICE_PUBLISH_POLICY,
      'manual',
      ['manual', 'approved_recipe'],
      'LLM_ADVICE_PUBLISH_POLICY',
    ),
    maxItems: integer(env, 'LLM_ADVICE_MAX_ITEMS', 3, 1, 3),
    provider,
    protocol: choice(
      env.LLM_RESEARCH_PROTOCOL,
      'messages',
      ['messages', 'responses'],
      'LLM_RESEARCH_PROTOCOL',
    ),
    apiKey: synthetic ? '' : env.LLM_RESEARCH_API_KEY || '',
    baseUrl: env.LLM_RESEARCH_BASE_URL || 'https://api.deepseek.com/anthropic',
    model: env.LLM_RESEARCH_MODEL || 'deepseek-flash',
    thinking: choice(
      env.LLM_RESEARCH_THINKING,
      'disabled',
      ['enabled', 'disabled'],
      'LLM_RESEARCH_THINKING',
    ),
    effort: choice(
      env.LLM_RESEARCH_EFFORT,
      'high',
      ['low', 'medium', 'high', 'max'],
      'LLM_RESEARCH_EFFORT',
    ),
    maxOutputTokens: integer(env, 'LLM_RESEARCH_MAX_OUTPUT_TOKENS', 4096, 512, 32768),
    timeoutMs: integer(env, 'LLM_RESEARCH_TIMEOUT_MS', 60000, 1, 120000),
    jobTimeoutMs: integer(env, 'LLM_RESEARCH_JOB_TIMEOUT_MS', 120000, 1, 600000),
    maxRetries: integer(env, 'LLM_RESEARCH_MAX_RETRIES', 3, 0, 3),
    maxConcurrency: integer(env, 'LLM_RESEARCH_MAX_CONCURRENCY', 1, 1, 1),
    maxPending: integer(env, 'LLM_RESEARCH_MAX_PENDING', 8, 1, 64),
    initialMinHands: integer(
      env,
      'LLM_RESEARCH_INITIAL_HANDS',
      Math.min(10, integer(env, 'LLM_RESEARCH_MIN_NEW_HANDS', 10, 1, 100)),
      1,
      100,
    ),
    minNewHands: integer(env, 'LLM_RESEARCH_MIN_NEW_HANDS', 10, 1, 100),
    leakMinNewHands: integer(env, 'LLM_RESEARCH_LEAK_MIN_NEW_HANDS', 25, 1, 100),
    intervalMs: integer(env, 'LLM_RESEARCH_INTERVAL_MS', 15000, 10, 3600000),
    inputPricePerMillion: price(env, 'LLM_RESEARCH_INPUT_PRICE_PER_MILLION'),
    outputPricePerMillion: price(env, 'LLM_RESEARCH_OUTPUT_PRICE_PER_MILLION'),
    cacheReadPricePerMillion: price(env, 'LLM_RESEARCH_CACHE_READ_PRICE_PER_MILLION'),
    cacheCreationPricePerMillion: price(env, 'LLM_RESEARCH_CACHE_CREATION_PRICE_PER_MILLION'),
  };
  endpoint(config.baseUrl, config.protocol);
  if (config.databasePath === resolve(rawPath))
    throw new Error('Research database must be separate from raw history');
  if (config.timeoutMs > config.jobTimeoutMs)
    throw new Error('Research request timeout exceeds job timeout');
  if (
    provider === 'deepseek' &&
    (config.protocol !== 'messages' ||
      !['deepseek-flash', 'deepseek-v4-pro'].includes(config.model))
  )
    throw new Error('DeepSeek research requires messages and an exact supported model ID');
  if (provider === 'standard' && config.effort === 'max')
    throw new Error('Research max effort requires DeepSeek');
  if (config.mode !== 'off' && !config.apiKey.trim())
    throw new Error('Enabled research requires LLM_RESEARCH_API_KEY');
  return config;
}
