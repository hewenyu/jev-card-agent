import type { Policy, ProviderMeter } from '../../core/types.js';
import type { StrategyName } from '../../shared/api.js';
import type { AppConfig } from '../../server/config.js';
import type { Store } from '../../storage/store.js';
import { LedgerMeter } from '../../storage/provider-meter.js';
import { JevProvider } from '../../policies/jev.js';
import { BaselinePolicy } from '../../policies/baseline.js';
import { HybridPolicy } from '../../policies/hybrid.js';
import { ReasoningProvider } from '../../policies/reasoning.js';
import { DeepSeekProvider } from '../../policies/deepseek.js';

/** Historical Choice/Hybrid controls only. Never used by the live runtime. */
export function reasoningFor(config: AppConfig, meter?: ProviderMeter): ReasoningProvider {
  if (config.reasoningProvider === 'deepseek')
    return new DeepSeekProvider({
      apiKey: config.reasoningApiKey,
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
      thinking: config.deepseekThinking,
      timeoutMs: config.reasoningTimeoutMs,
      effort: config.reasoningEffort,
      maxOutputTokens: config.reasoningMaxOutputTokens,
      meter,
    });
  return new ReasoningProvider({
    apiKey: config.reasoningApiKey,
    baseUrl: config.reasoningBaseUrl,
    protocol: config.reasoningProtocol,
    model:
      config.reasoningProtocol === 'messages'
        ? config.reasoningMessagesModel
        : config.reasoningModel,
    timeoutMs: config.reasoningTimeoutMs,
    effort: config.reasoningEffort,
    maxOutputTokens: config.reasoningMaxOutputTokens,
    meter,
  });
}
export function ledgerFor(config: AppConfig, store: Store, runId: string): LedgerMeter {
  return new LedgerMeter(store, runId, {
    reasoningInputPerMillion: config.reasoningInputPricePerMillion,
    reasoningCacheReadInputPerMillion: config.reasoningCacheReadInputPricePerMillion,
    reasoningOutputPerMillion: config.reasoningOutputPricePerMillion,
  });
}
export function policyFor(
  config: AppConfig,
  strategy: StrategyName,
  meter?: ProviderMeter,
): Policy {
  if (strategy === 'baseline') return new BaselinePolicy();
  const jev = new JevProvider({
    apiKey: config.jevApiKey,
    baseUrl: config.jevBaseUrl,
    model: config.jevModel,
    timeoutMs: config.jevTimeoutMs,
    meter,
  });
  if (strategy === 'jev-reasoning') {
    if (!meter) throw new Error('Hybrid decisions require a provider usage ledger');
    return new HybridPolicy({
      jev,
      reasoning: reasoningFor(config, meter),
      totalBudgetMs: config.hybridTimeoutMs,
      reasoningMode: config.reasoningMode,
    });
  }
  return jev;
}
