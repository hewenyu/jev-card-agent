import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuelLoopError, type DecisionModel } from 'duelloop';
import { AuditedDecisionModel } from '../src/duelloop/model.js';
import { retryDelay, waitForRetry } from '../src/duelloop/retry.js';

type Response = Awaited<ReturnType<DecisionModel['score']>>;
const response: Response = {
  model: 'retry-test',
  answers: {
    quality: { score: 0.7, confidence: 0.6, probabilities: { '0': 0.3, '1': 0.7 } },
  },
  usage: { unknown: true },
};
const request = (signal: AbortSignal): Parameters<DecisionModel['score']>[0] => ({
  signal,
  state: { pot: 40 },
  questions: [
    {
      id: 'quality',
      actionId: 'raise',
      dimensionId: 'quality',
      instructions: 'Evaluate this priced action',
      criteria: ['weak', 'strong'],
    },
  ],
});
const model = (score: DecisionModel['score'], record = vi.fn()) =>
  new AuditedDecisionModel(
    {
      id: 'retry-test',
      kind: 'real',
      behaviorIdentity: {
        adapterVersion: 'retry-test',
        deploymentVersion: 'retry-test',
        protocolVersion: 'score',
        configurationDigest: 'test',
      },
      score,
    },
    record,
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DuelLoop shared-deadline backoff', () => {
  it('recovers from a 100 ms rate limit within the original 1 s window', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const controller = new AbortController();
    const started = performance.now();
    const persisted = vi.fn();
    const call = vi.fn<DecisionModel['score']>(async (input) => {
      expect(input.signal).toBe(controller.signal);
      expect(persisted).toHaveBeenCalledTimes(call.mock.calls.length - 1);
      if (performance.now() - started < 100)
        throw new DuelLoopError('MODEL_INVALID', 'private', {
          status: 429,
          failureKind: 'http',
          retryAfterMs: 100,
        });
      return response;
    });
    const audited = model(call, persisted);
    const deadline = setTimeout(() => controller.abort(), 1_000);
    const pending = audited.score(request(controller.signal));
    await vi.advanceTimersByTimeAsync(99);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ model: 'retry-test' });
    expect(call).toHaveBeenCalledTimes(2);
    expect(controller.signal.aborted).toBe(false);
    expect(audited.attempts[0]).toMatchObject({ httpStatus: 429, retryAfterMs: 100 });
    clearTimeout(deadline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses exponential waits and at most three retries for transport failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const times: number[] = [];
    const call = vi.fn<DecisionModel['score']>(async () => {
      times.push(performance.now());
      throw new DuelLoopError('MODEL_INVALID', 'private', { failureKind: 'network' });
    });
    const pending = model(call).score(request(new AbortController().signal));
    const assertion = expect(pending).rejects.toMatchObject({ code: 'MODEL_INVALID' });
    await vi.advanceTimersByTimeAsync(700);
    await assertion;
    expect(times.map((time) => time - times[0]!)).toEqual([0, 100, 300, 700]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds bounded jitter and treats Retry-After as a minimum, never a cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const failure = { code: 'MODEL_INVALID', httpStatus: 503 } as const;
    expect(retryDelay(failure, 0)).toBe(112.5);
    expect(retryDelay(failure, 2)).toBe(450);
    expect(retryDelay({ ...failure, retryAfterMs: 90_000 }, 2)).toBe(90_000);
    expect(retryDelay({ code: 'MODEL_TIMEOUT' }, 0)).toBe(112.5);
    expect(retryDelay({ ...failure, httpStatus: 401 }, 0)).toBeNull();
  });

  it.each([5_000, Number.MAX_VALUE])(
    'cancels an unclamped Retry-After of %s under the original deadline',
    async (retryAfterMs) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const call = vi.fn<DecisionModel['score']>().mockRejectedValue(
        new DuelLoopError('MODEL_INVALID', 'private', {
          status: 429,
          failureKind: 'http',
          retryAfterMs,
        }),
      );
      const audited = model(call);
      const pending = audited.score(request(controller.signal));
      const assertion = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      setTimeout(() => controller.abort(), 1_000);
      await vi.advanceTimersByTimeAsync(999);
      expect(call).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(call).toHaveBeenCalledTimes(1);
      expect(audited.attempts).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not retry before a Retry-After spanning more than one safe Node timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForRetry(2_147_483_647 + 500, controller.signal);
    const finished = vi.fn();
    void pending.then(finished);
    await vi.advanceTimersByTimeAsync(2_147_483_647 + 499);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps malformed answers separate from network failures and retries immediately', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn<DecisionModel['score']>()
      .mockResolvedValueOnce({ ...response, answers: {} })
      .mockResolvedValueOnce(response);
    const audited = model(call);
    await expect(audited.score(request(new AbortController().signal))).resolves.toMatchObject({
      model: 'retry-test',
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(audited.attempts[0]).toMatchObject({ code: 'MODEL_INVALID' });
    expect(audited.attempts[0]).not.toHaveProperty('failureKind');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never schedules a retry when its failed-attempt ledger cannot be written', async () => {
    vi.useFakeTimers();
    const call = vi.fn<DecisionModel['score']>().mockRejectedValue(
      new DuelLoopError('MODEL_INVALID', 'private', {
        status: 503,
        failureKind: 'http',
        retryAfterMs: 100,
      }),
    );
    const record = vi.fn(() => {
      throw new Error('disk failure');
    });
    await expect(
      model(call, record).score(request(new AbortController().signal)),
    ).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
