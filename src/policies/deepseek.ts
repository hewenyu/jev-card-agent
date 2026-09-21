import { z } from 'zod';
import { ReasoningProvider, type ReasoningConfig, type ReasoningDialect } from './reasoning.js';

export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export interface DeepSeekConfig extends Omit<
  ReasoningConfig,
  'protocol' | 'baseUrl' | 'model' | 'allowedActualModels'
> {
  baseUrl?: string;
  model?: string;
  thinking?: 'enabled' | 'disabled';
}

const usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  cache_creation_input_tokens: z.number().int().nonnegative().default(0),
});

function dialect(thinking: 'enabled' | 'disabled'): ReasoningDialect {
  return {
    provider: 'deepseek',
    supportsMaxEffort: true,
    configuration(config) {
      return {
        thinking,
        ...(thinking === 'enabled'
          ? { effort: config.effort === 'medium' ? 'high' : (config.effort ?? 'high') }
          : {}),
      };
    },
    request(input, config, maxOutputTokens) {
      const effort = config.effort === 'medium' ? 'high' : (config.effort ?? 'high');
      return {
        model: config.model,
        max_tokens: maxOutputTokens,
        messages: [{ role: 'user', content: input }],
        thinking: { type: thinking },
        ...(thinking === 'enabled' ? { output_config: { effort } } : {}),
        stream: false,
      };
    },
    normalizeResponse(raw) {
      if (!raw || typeof raw !== 'object' || !('usage' in raw) || raw.usage == null) return raw;
      const tokens = usage.parse(raw.usage);
      // Anthropic input_tokens counts uncached input; cache categories are additional input.
      // Store the total once, retaining cache fields for their separate ledger prices.
      return {
        ...raw,
        usage: {
          ...tokens,
          input_tokens:
            tokens.input_tokens +
            tokens.cache_read_input_tokens +
            tokens.cache_creation_input_tokens,
        },
      };
    },
  };
}

/** DeepSeek's Anthropic-compatible API has explicit thinking and distinct cache accounting. */
export class DeepSeekProvider extends ReasoningProvider {
  constructor(config: DeepSeekConfig) {
    const model = config.model ?? 'deepseek-flash';
    if (!DEEPSEEK_MODELS.some((known) => known === model))
      throw new Error('Unsupported DeepSeek model; use an exact published model ID');
    const thinking = config.thinking ?? 'enabled';
    if (!['enabled', 'disabled'].includes(thinking))
      throw new Error('Invalid DeepSeek thinking mode');
    super(
      {
        ...config,
        model,
        baseUrl: config.baseUrl ?? 'https://api.deepseek.com/anthropic',
        protocol: 'messages',
        // Unknown model IDs silently map upstream; aliases must never bypass identity checks.
        allowedActualModels: [],
      },
      dialect(thinking),
    );
  }
}
