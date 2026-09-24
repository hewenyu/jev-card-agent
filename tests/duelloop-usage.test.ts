import { describe, expect, it } from 'vitest';
import { accumulateUsage, emptyUsage, normalizeUsage } from '../src/duelloop/usage.js';

describe('DuelLoop token and dollar completeness', () => {
  it('keeps official Jev token-only usage cost-unknown', () => {
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 5, unknown: false })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      unknown: false,
      knownCostUsd: 0,
      costUnknown: true,
    });
  });
  it('keeps a known subtotal without claiming the partially observed bill is complete', () => {
    const total = emptyUsage();
    accumulateUsage(total, { inputTokens: 10, outputTokens: 5, costUsd: 0.2 });
    accumulateUsage(total, {
      inputTokens: 10,
      outputTokens: 5,
      knownCostUsd: 0.3,
      costUnknown: true,
    });
    expect(total).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      unknown: false,
      knownCostUsd: 0.5,
      costUnknown: true,
    });
    accumulateUsage(total, { inputTokens: 10, outputTokens: 5, costUsd: 0.1 });
    expect(total.costUnknown).toBe(true);
    expect(total.costUsd).toBeUndefined();
    expect(total.knownCostUsd).toBeCloseTo(0.6);
  });
  it('distinguishes an explicitly free fixture from missing billing data', () => {
    expect(normalizeUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 })).toMatchObject({
      unknown: false,
      costUnknown: false,
      costUsd: 0,
      knownCostUsd: 0,
    });
    expect(normalizeUsage(undefined)).toEqual({
      unknown: true,
      costUnknown: true,
      knownCostUsd: 0,
    });
  });
  it('does not infer token completeness from a complete dollar cost', () => {
    const total = emptyUsage();
    accumulateUsage(total, { costUsd: 0.5 });
    expect(total).toMatchObject({ unknown: true, costUnknown: false, costUsd: 0.5 });
  });
  it.each([
    { costUsd: -1 },
    { costUsd: Infinity },
    { costUsd: 1, knownCostUsd: 2 },
    { costUsd: 1, knownCostUsd: 'private' },
  ])('rejects invalid or contradictory complete cost %#', (value) => {
    const normalized = normalizeUsage(value);
    expect(normalized.costUnknown).toBe(true);
    expect(normalized).not.toHaveProperty('costUsd');
    expect(JSON.stringify(normalized)).not.toContain('private');
  });
  it('marks overflow incomplete without exporting nonfinite totals', () => {
    const total = emptyUsage();
    for (let i = 0; i < 2; i++)
      accumulateUsage(total, {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        costUsd: Number.MAX_VALUE,
      });
    expect(total).toMatchObject({ unknown: true, costUnknown: true });
    expect(total.costUsd).toBeUndefined();
    expect(Number.isFinite(total.knownCostUsd)).toBe(true);
  });
});
