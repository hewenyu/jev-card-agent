import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../src/core/index.js';
import { ProviderError, ProviderLedgerError } from '../src/policies/metering.js';
import type { DecisionOptions, ProviderAttempt } from '../src/core/types.js';
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
  it('collects delayed cancellation attempts, preserves analysis, and freezes late progress', async () => {
    let callback: DecisionOptions['onProgress'];
    const phases: string[] = [];
    const attempt: ProviderAttempt = {
      id: 'cancelled-call',
      provider: 'jev',
      purpose: 'reconsider',
      requestedModel: 'jev-test',
      actualModel: null,
      status: 'cancelled',
      latencyMs: 15,
      usage: null,
    };
    const result = await decide(
      task(),
      {
        apiKey: 'unused',
        store: {} as RuntimeStore,
        policy: {
          decide: async (_context, _candidates, options) => {
            callback = options?.onProgress;
            callback?.({
              phase: 'jev',
              analysis: 'Completed advisory',
              thinking: 'Returned summary',
              thinkingSource: 'summary',
            });
            await new Promise<void>((_resolve, reject) =>
              options?.signal?.addEventListener(
                'abort',
                () => {
                  setTimeout(() => {
                    callback?.({ phase: 'jev', attempts: [attempt] });
                    reject(new ProviderError('jev_cancelled', attempt));
                  }, 10);
                },
                { once: true },
              ),
            );
            throw new Error('unreachable');
          },
        },
      },
      'run',
      15,
      (progress) => phases.push(progress.phase),
    );
    expect(result?.action).toBeNull();
    expect(result?.decision.status).toBe('failed');
    expect(result?.decision.proposal.attempts).toEqual([attempt]);
    expect(result?.decision.proposal.routing?.analysis).toBe('Completed advisory');
    expect(result?.decision.proposal.routing?.thinking).toBe('Returned summary');
    expect(phases).toEqual(['jev']);
    callback?.({
      phase: 'jev',
      analysis: 'Late overwrite',
      attempts: [{ ...attempt, id: 'late' }],
    });
    expect(phases).toEqual(['jev']);
    expect(result?.decision.proposal.attempts).toHaveLength(1);
  });

  it('returns a cancelled trace with no action and bounds uncooperative policies', async () => {
    const current = task();
    const promise = decide(
      current,
      {
        apiKey: 'unused',
        store: {} as RuntimeStore,
        policy: {
          decide: async (_context, _candidates, options) => {
            options?.onProgress?.({ phase: 'reasoning', analysis: 'Partial provider result' });
            return await new Promise(() => {});
          },
        },
      },
      'run',
      10000,
    );
    current.controller.abort();
    const result = await promise;
    expect(result?.decision.status).toBe('cancelled');
    expect(result?.action).toBeNull();
    expect(result?.decision.proposal.candidateId).toBe('');
    expect(result?.decision.proposal.routing?.analysis).toBe('Partial provider result');
  });

  it('records provider ledger failures without submitting a fallback', async () => {
    const result = await decide(
      task(),
      {
        apiKey: 'unused',
        store: {} as RuntimeStore,
        policy: {
          decide: async () => {
            throw new ProviderLedgerError(new Error('ledger failed'));
          },
        },
      },
      'run',
      1000,
    );
    expect(result?.decision.status).toBe('failed');
    expect(result?.decision.fallbackReason).toBe('ledger failed');
    expect(result?.action).toBeNull();
  });

  it('preserves failed-provider usage and diagnostics without submitting a fallback', async () => {
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
    const result = await decide(
      task(),
      {
        apiKey: 'unused',
        store: {} as RuntimeStore,
        policy: {
          decide: async () => {
            throw new ProviderError('invalid_choice', attempt);
          },
        },
      },
      'run1',
      1000,
    );
    expect(result?.action).toBeNull();
    expect(result?.decision.status).toBe('failed');
    expect(result?.decision.proposal.source).toBe('unavailable');
    expect(result?.decision.proposal.attempts).toEqual([attempt]);
    expect(result?.decision.fallbackReason).toBe('invalid_choice');
  });

  it('rejects a local policy proposal in strict Jev mode', async () => {
    const policy = {
      decide: vi.fn(async () => ({
        candidateId: 'check',
        selected: 'check',
        source: 'baseline' as const,
        explanation: 'local rule',
        latencyMs: 0,
      })),
    };
    const result = await decide(
      task(),
      { apiKey: 'unused', store: {} as RuntimeStore, policy },
      'run1',
      1000,
    );
    expect(result?.action).toBeNull();
    expect(result?.decision.status).toBe('failed');
    expect(result?.decision.fallbackReason).toBe('non_jev_policy_proposal');
    expect(result?.decision.proposal.selected).toBe('');
  });

  it('does not call a model or select a local action when recovery time is unknown', async () => {
    const current = { ...task(), recovered: true };
    const policy = { decide: vi.fn() };
    const result = await decide(
      current,
      { apiKey: 'unused', store: {} as RuntimeStore, policy },
      'run1',
      1000,
    );
    expect(policy.decide).not.toHaveBeenCalled();
    expect(result?.decision.status).toBe('failed');
    expect(result?.decision.fallbackReason).toBe('recovered_turn_unknown_remaining_time');
    expect(result?.action).toBeNull();
  });
});
