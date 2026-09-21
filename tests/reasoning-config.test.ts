import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

describe('backend reasoning configuration', () => {
  it('defaults to mandatory reasoning, high effort and a metered output cap', () => {
    expect(loadConfig({})).toMatchObject({
      reasoningMode: 'always',
      reasoningEffort: 'high',
      reasoningMaxOutputTokens: 4096,
    });
  });
  it('requires an explicit adaptive mode and accepts bounded provider settings', () => {
    expect(
      loadConfig({
        REASONING_MODE: 'adaptive',
        REASONING_EFFORT: 'medium',
        REASONING_MAX_OUTPUT_TOKENS: '8192',
      }),
    ).toMatchObject({
      reasoningMode: 'adaptive',
      reasoningEffort: 'medium',
      reasoningMaxOutputTokens: 8192,
    });
  });
  it.each([
    { REASONING_MODE: 'sometimes' },
    { REASONING_EFFORT: 'unknown' },
    { REASONING_MAX_OUTPUT_TOKENS: '0' },
    { REASONING_MAX_OUTPUT_TOKENS: '1.5' },
    { REASONING_MAX_OUTPUT_TOKENS: '32769' },
  ])('rejects invalid reasoning settings %o', (env) => {
    expect(() => loadConfig(env)).toThrow(/REASONING_/);
  });
});
