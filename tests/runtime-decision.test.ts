import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../src/core/index.js';
import { ProviderError } from '../src/policies/metering.js';
import { authorityKey, decide, type DecisionTask } from '../src/runtime/decision.js';
import type { RuntimeStore } from '../src/runtime/types.js';

function task(): DecisionTask {
  const state = {
    ...createInitialState(),
    handId: 'hand1',
    tableId: 'table1',
    turnToken: 'turn1',
    heroSeat: 0,
    actorSeat: 0,
    validActions: [{ action: 'check' as const }, { action: 'fold' as const }],
  };
  return {
    key: authorityKey(state),
    state,
    controller: new AbortController(),
    deadlineAt: Date.now() + 10_000,
    recovered: false,
    opponents: [],
  };
}

describe('decision failure accounting', () => {
  it('settles known failed-provider usage and preserves diagnostics in the legal fallback trace', async () => {
    const attempt = {
      id: 'attempt1',
      provider: 'jev' as const,
      purpose: 'decision' as const,
      requestedModel: 'jev-1.13.0',
      actualModel: 'jev-1.13.0',
      status: 'failed' as const,
      usage: { input_tokens: 765, output_tokens: 2 },
      latencyMs: 140,
      errorCode: 'invalid_choice',
      diagnostics: { choice: 'unknown', probabilitySum: 0.82 },
    };
    const budget = { reserve: vi.fn(() => 'reservation1'), settle: vi.fn() };
    const result = await decide(
      task(),
      {
        apiKey: 'unused',
        store: {} as RuntimeStore,
        budget,
        policy: {
          decide: async () => {
            throw new ProviderError('invalid_choice', attempt);
          },
        },
      },
      'run1',
      1000,
    );
    expect(result?.action.payload.action).toBe('check');
    expect(result?.decision.proposal.source).toBe('fallback');
    expect(result?.decision.proposal.attempts).toEqual([attempt]);
    expect(result?.decision.fallbackReason).toBe('invalid_choice');
    expect(budget.settle).toHaveBeenCalledTimes(1);
    expect(budget.settle).toHaveBeenCalledWith(
      'reservation1',
      expect.objectContaining({ usage: attempt.usage }),
    );
  });

  it('keeps unknown failures reserved and refuses to hide ledger failures as model fallbacks', async () => {
    const budget = { reserve: vi.fn(() => 'reservation1'), settle: vi.fn() };
    await decide(
      task(),
      {
        apiKey: 'unused',
        store: {} as RuntimeStore,
        budget,
        policy: {
          decide: async () => {
            throw new Error('network failure');
          },
        },
      },
      'run1',
      1000,
    );
    expect(budget.settle).toHaveBeenCalledWith('reservation1', null);
    const policy = { decide: vi.fn() };
    budget.reserve.mockImplementation(() => {
      throw new Error('ledger unavailable');
    });
    await expect(
      decide(task(), { apiKey: 'unused', store: {} as RuntimeStore, budget, policy }, 'run1', 1000),
    ).rejects.toThrow('ledger unavailable');
    expect(policy.decide).not.toHaveBeenCalled();
  });
});
