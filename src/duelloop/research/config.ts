import { resolve } from 'node:path';
import type { ResearchBudget } from 'duelloop';

export interface ResearchProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: 'deepseek-flash' | 'deepseek-v4-pro';
  thinking: 'enabled' | 'disabled';
  effort: 'high' | 'max';
  timeoutMs: number;
  maxOutputTokens: number;
  maxToolTurns: number;
  maxRetries: number;
}
export interface DuelLoopResearchConfig {
  enabled: boolean;
  activationMode: 'explicit' | 'candidate_only' | 'automatic_after_validation';
  provider: ResearchProviderConfig;
  jev: { apiKey: string; baseUrl: string; model: string; timeoutMs: number };
  decisionPolicy: { maxDecisionMs: number; executionReserveMs: number };
  developmentProtocolPath: string;
  finalProtocolPath: string;
  settledTrajectories: number;
  cooldownMs: number;
  pollIntervalMs: number;
  maxDecisions: number;
  maxFeedback: number;
  maxRounds: number;
  budget: ResearchBudget;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1, max = 1e9) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
/** New controls are explicit: an old ASYNC_LLM_MODE never enables SDK research. */
export function parseDuelLoopResearchConfig(env: NodeJS.ProcessEnv): DuelLoopResearchConfig {
  if (env.DUELLOOP_RESEARCH_ENABLED && !['true', 'false'].includes(env.DUELLOOP_RESEARCH_ENABLED))
    throw new Error('DUELLOOP_RESEARCH_ENABLED must be true or false');
  const enabled = env.DUELLOOP_RESEARCH_ENABLED === 'true';
  const model = env.DUELLOOP_RESEARCH_MODEL || 'deepseek-flash';
  if (model !== 'deepseek-flash' && model !== 'deepseek-v4-pro')
    throw new Error('DUELLOOP_RESEARCH_MODEL requires an exact supported DeepSeek identity');
  const thinking = env.DUELLOOP_RESEARCH_THINKING || 'enabled';
  if (thinking !== 'enabled' && thinking !== 'disabled')
    throw new Error('DUELLOOP_RESEARCH_THINKING must be enabled or disabled');
  const effort = env.DUELLOOP_RESEARCH_EFFORT || 'high';
  if (effort !== 'high' && effort !== 'max') throw new Error('Invalid DUELLOOP_RESEARCH_EFFORT');
  const activationMode = env.DUELLOOP_ACTIVATION_MODE || 'automatic_after_validation';
  if (
    activationMode !== 'explicit' &&
    activationMode !== 'candidate_only' &&
    activationMode !== 'automatic_after_validation'
  )
    throw new Error('Invalid DUELLOOP_ACTIVATION_MODE');
  const config: DuelLoopResearchConfig = {
    enabled,
    activationMode,
    provider: {
      apiKey: env.DUELLOOP_RESEARCH_API_KEY || '',
      baseUrl: env.DUELLOOP_RESEARCH_BASE_URL || 'https://api.deepseek.com/anthropic',
      model,
      thinking,
      effort,
      timeoutMs: integer(env, 'DUELLOOP_RESEARCH_REQUEST_TIMEOUT_MS', 60000),
      maxOutputTokens: integer(env, 'DUELLOOP_RESEARCH_MAX_OUTPUT_TOKENS', 8192, 1, 32768),
      maxToolTurns: integer(env, 'DUELLOOP_RESEARCH_MAX_TOOL_TURNS', 24, 1, 100),
      maxRetries: 3,
    },
    jev: {
      apiKey: env.JEV_API_KEY || '',
      baseUrl: env.JEV_BASE_URL || 'https://api.typesafe.ai',
      model: env.JEV_MODEL || 'jev-1.13.0',
      timeoutMs: integer(env, 'JEV_TIMEOUT_MS', 10000),
    },
    decisionPolicy: {
      maxDecisionMs: integer(env, 'JEV_DECISION_TIMEOUT_MS', 40000),
      executionReserveMs: integer(env, 'DUELLOOP_EXECUTION_RESERVE_MS', 1500, 0),
    },
    developmentProtocolPath: resolve(
      env.DUELLOOP_DEVELOPMENT_PROTOCOL || 'data/protocols/development.json',
    ),
    finalProtocolPath: resolve(env.DUELLOOP_FINAL_PROTOCOL || 'data/protocols/final.json'),
    settledTrajectories: integer(env, 'DUELLOOP_RESEARCH_SETTLED_HANDS', 100),
    cooldownMs: integer(env, 'DUELLOOP_RESEARCH_COOLDOWN_MS', 300000, 0),
    pollIntervalMs: integer(env, 'DUELLOOP_RESEARCH_POLL_MS', 5000, 10, 60000),
    maxDecisions: integer(env, 'DUELLOOP_RESEARCH_SNAPSHOT_DECISIONS', 500, 1, 10000),
    maxFeedback: integer(env, 'DUELLOOP_RESEARCH_SNAPSHOT_HANDS', 1000, 1, 10000),
    maxRounds: integer(env, 'DUELLOOP_RESEARCH_MAX_ROUNDS', 2, 1, 10),
    budget: {
      maxWallTimeSeconds: integer(env, 'DUELLOOP_RESEARCH_MAX_SECONDS', 3600),
      maxTokensTotal: integer(env, 'DUELLOOP_RESEARCH_MAX_TOKENS', 1000000),
      maxModelCalls: integer(env, 'DUELLOOP_RESEARCH_MAX_CALLS', 12),
      maxDecisionModelCalls: integer(env, 'DUELLOOP_EVALUATION_MAX_CALLS', 10000),
      maxRepairAttempts: integer(env, 'DUELLOOP_RESEARCH_MAX_REPAIRS', 1, 0, 3),
    },
  };
  if (enabled && (!config.provider.apiKey || !config.jev.apiKey))
    throw new Error('Enabled DuelLoop research requires DUELLOOP_RESEARCH_API_KEY and JEV_API_KEY');
  return config;
}

/** Build explicitly; never spread AppConfig or process.env into an isolated worker. */
export function researchWorkerConfig(c: DuelLoopResearchConfig): DuelLoopResearchConfig {
  const p = c.provider;
  return {
    enabled: c.enabled,
    activationMode: c.activationMode,
    provider: {
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      model: p.model,
      thinking: p.thinking,
      effort: p.effort,
      timeoutMs: p.timeoutMs,
      maxOutputTokens: p.maxOutputTokens,
      maxToolTurns: p.maxToolTurns,
      maxRetries: p.maxRetries,
    },
    jev: {
      apiKey: c.jev.apiKey,
      baseUrl: c.jev.baseUrl,
      model: c.jev.model,
      timeoutMs: c.jev.timeoutMs,
    },
    decisionPolicy: {
      maxDecisionMs: c.decisionPolicy.maxDecisionMs,
      executionReserveMs: c.decisionPolicy.executionReserveMs,
    },
    developmentProtocolPath: c.developmentProtocolPath,
    finalProtocolPath: c.finalProtocolPath,
    settledTrajectories: c.settledTrajectories,
    cooldownMs: c.cooldownMs,
    pollIntervalMs: c.pollIntervalMs,
    maxDecisions: c.maxDecisions,
    maxFeedback: c.maxFeedback,
    maxRounds: c.maxRounds,
    budget: {
      maxWallTimeSeconds: c.budget.maxWallTimeSeconds,
      maxTokensTotal: c.budget.maxTokensTotal,
      maxModelCalls: c.budget.maxModelCalls,
      maxDecisionModelCalls: c.budget.maxDecisionModelCalls,
      maxRepairAttempts: c.budget.maxRepairAttempts,
    },
  };
}
