import { describe, expect, it, vi } from 'vitest';
import { DuelLoopError, type DecisionModel } from 'duelloop';
import { AuditedDecisionModel, type ModelAttempt } from '../src/duelloop/model.js';

type Response = Awaited<ReturnType<DecisionModel['score']>>;
function request(signal = new AbortController().signal): Parameters<DecisionModel['score']>[0] {
  return {
    signal,
    state: { pot: 40 },
    questions: [
      {
        id: 'raise.quality',
        actionId: 'raise',
        dimensionId: 'quality',
        instructions: 'Evaluate this priced action',
        criteria: ['weak', 'strong'],
      },
    ],
  };
}
function result(): Response {
  return {
    model: 'jev-test',
    answers: {
      'raise.quality': { score: 0.7, confidence: 0.6, probabilities: { '0': 0.3, '1': 0.7 } },
    },
    usage: { inputTokens: 20, outputTokens: 3, unknown: false },
  };
}
function inner(score = vi.fn<DecisionModel['score']>().mockResolvedValue(result())): DecisionModel {
  return {
    id: 'jev-test',
    kind: 'real',
    behaviorIdentity: {
      adapterVersion: 'fixture-transport',
      deploymentVersion: 'jev-test',
      protocolVersion: 'score',
      configurationDigest: 'test',
    },
    score,
  };
}

describe('DuelLoop audited model', () => {
  it('retries transient failures only after persisting each attempt, without replacing the shared signal', async () => {
    const persisted: ModelAttempt[] = [];
    const input = request();
    const call = vi.fn<DecisionModel['score']>(async (actual) => {
      expect(actual.signal).toBe(input.signal);
      expect(persisted).toHaveLength(call.mock.calls.length - 1);
      if (call.mock.calls.length < 4)
        throw new DuelLoopError('MODEL_INVALID', 'provider private body', {
          status: 429,
          usage: { inputTokens: 2, outputTokens: 1, unknown: false },
        });
      return result();
    });
    const model = new AuditedDecisionModel(inner(call), (attempt) => persisted.push(attempt));
    const response = await model.score(input);
    expect(call).toHaveBeenCalledTimes(4);
    expect(response.usage).toEqual({ inputTokens: 26, outputTokens: 6, unknown: false });
    expect(model.attempts).toEqual(persisted);
    expect(persisted.map((a) => a.retryIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(persisted.map((a) => a.requestHash)).size).toBe(1);
    expect(persisted.at(-1)).toMatchObject({ status: 'succeeded', actualModel: 'jev-test' });
    expect(persisted.every((a) => a.latencyMs >= 0)).toBe(true);
    expect(JSON.stringify(model.attempts)).not.toContain('provider private body');
  });

  it.each([401, 402, 403, 400, 404])('does not retry terminal HTTP %s', async (status) => {
    const call = vi
      .fn<DecisionModel['score']>()
      .mockRejectedValue(new DuelLoopError('MODEL_INVALID', 'private', { status }));
    const model = new AuditedDecisionModel(inner(call), () => {});
    await expect(model.score(request())).rejects.toMatchObject({
      code: 'MODEL_INVALID',
      context: { status, usage: { unknown: true } },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each(['CONFIG_INVALID', 'VERSION_INCOMPATIBLE', 'CANCELLED', 'ACCESS_DENIED'] as const)(
    'does not retry %s',
    async (code) => {
      const call = vi
        .fn<DecisionModel['score']>()
        .mockRejectedValue(new DuelLoopError(code, 'private', { status: 503 }));
      const model = new AuditedDecisionModel(inner(call), () => {});
      await expect(model.score(request())).rejects.toMatchObject({ code });
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it('sanitizes exhausted unknown failures and never fabricates an action', async () => {
    const call = vi
      .fn<DecisionModel['score']>()
      .mockRejectedValue(new Error('Bearer fake-secret: private response'));
    const model = new AuditedDecisionModel(inner(call), () => {});
    const error = await model.score(request()).catch((e) => e as DuelLoopError);
    expect(error).toBeInstanceOf(DuelLoopError);
    expect(error).toMatchObject({ code: 'MODEL_INVALID', context: { usage: { unknown: true } } });
    expect(call).toHaveBeenCalledTimes(4);
    expect(JSON.stringify({ error, attempts: model.attempts })).not.toContain('fake-secret');
    expect(model.attempts.every((a) => a.status === 'failed')).toBe(true);
  });

  it('keeps known usage when earlier usage is missing and continues retrying', async () => {
    const call = vi
      .fn<DecisionModel['score']>()
      .mockRejectedValueOnce(new DuelLoopError('MODEL_TIMEOUT', 'timeout'))
      .mockResolvedValueOnce(result());
    const model = new AuditedDecisionModel(inner(call), () => {});
    await expect(model.score(request())).resolves.toMatchObject({
      usage: { inputTokens: 20, outputTokens: 3, unknown: true },
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each([
    { answers: {} },
    {
      answers: {
        'raise.quality': { score: 20, confidence: 0.5, probabilities: { '0': 0.5, '1': 0.5 } },
      },
    },
    {
      answers: {
        'raise.quality': { score: 0.5, confidence: 2, probabilities: { '0': 0.5, '1': 0.5 } },
      },
    },
    {
      answers: {
        'raise.quality': { score: 0.5, confidence: 0.5, probabilities: { '0': 0.2, '1': 0.2 } },
      },
    },
    { model: '' },
  ])(
    'validates answers inside the retry boundary and accounts for rejected responses %#',
    async (invalid) => {
      const call = vi
        .fn<DecisionModel['score']>()
        .mockResolvedValueOnce({ ...result(), ...invalid } as Response)
        .mockResolvedValueOnce(result());
      const model = new AuditedDecisionModel(inner(call), () => {});
      await expect(model.score(request())).resolves.toMatchObject({
        usage: { inputTokens: 40, outputTokens: 6, unknown: false },
      });
      expect(call).toHaveBeenCalledTimes(2);
      expect(model.attempts[0]).toMatchObject({ status: 'failed', code: 'MODEL_INVALID' });
    },
  );

  it('fails version mismatch once, preserves usage, and excludes unexpected provider text', async () => {
    const call = vi
      .fn<DecisionModel['score']>()
      .mockResolvedValue({ ...result(), model: 'credential-bearing-provider-text' });
    const model = new AuditedDecisionModel(inner(call), () => {});
    await expect(model.score(request())).rejects.toMatchObject({
      code: 'VERSION_INCOMPATIBLE',
      context: { usage: result().usage },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.attempts)).not.toContain('credential-bearing-provider-text');
  });

  it('retries probability sums accepted by a loose adapter but rejected by the SDK runtime', async () => {
    const invalid = result();
    invalid.answers['raise.quality']!.probabilities = { '0': 0.3, '1': 0.709 };
    const call = vi
      .fn<DecisionModel['score']>()
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(result());
    const model = new AuditedDecisionModel(inner(call), () => {});
    await expect(model.score(request())).resolves.toMatchObject({
      usage: { inputTokens: 40, outputTokens: 6, unknown: false },
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(model.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
    expect(model.attempts[0]?.code).toBe('MODEL_INVALID');
  });

  it('does not issue requests for an already aborted shared deadline', async () => {
    const call = vi.fn<DecisionModel['score']>();
    const model = new AuditedDecisionModel(inner(call), () => {});
    await expect(model.score(request(AbortSignal.abort()))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(call).not.toHaveBeenCalled();
    expect(model.attempts).toHaveLength(0);
  });

  it('rejects a late answer, retains its usage, and never starts another request', async () => {
    const controller = new AbortController();
    const call = vi.fn<DecisionModel['score']>(async () => {
      controller.abort();
      return result();
    });
    const model = new AuditedDecisionModel(inner(call), () => {});
    await expect(model.score(request(controller.signal))).rejects.toMatchObject({
      code: 'CANCELLED',
      context: { usage: { unknown: true } },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(model.attempts[0]).toMatchObject({ status: 'failed', code: 'CANCELLED' });
    expect(model.lateResults[0]).toMatchObject({ status: 'succeeded', usage: result().usage });
  });

  it('synchronously records cancellation even when the transport never settles', async () => {
    const controller = new AbortController();
    const persisted: ModelAttempt[] = [];
    const onStart = vi.fn();
    const call = vi.fn<DecisionModel['score']>(() => {
      expect(onStart).toHaveBeenCalledTimes(1);
      return new Promise(() => {});
    });
    const model = new AuditedDecisionModel(inner(call), (attempt) => persisted.push(attempt), {
      onStart,
    });
    const pending = model.score(request(controller.signal));
    expect(persisted).toHaveLength(0);
    controller.abort();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      status: 'failed',
      code: 'CANCELLED',
      usage: { unknown: true },
    });
    expect(onStart.mock.calls[0]?.[0].requestId).toBe(persisted[0]?.requestId);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps late settlement separate from the cancelled attempt (failure: %s)',
    async (rejected) => {
      const controller = new AbortController();
      let resolve!: (response: Response) => void;
      let reject!: (error: unknown) => void;
      const call = vi.fn<DecisionModel['score']>(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const record = vi.fn();
      const onLateResult = vi.fn();
      const model = new AuditedDecisionModel(inner(call), record, { onLateResult });
      const pending = model.score(request(controller.signal));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      const original = structuredClone(model.attempts);
      // The main ledger may now be closed. Any late data must use only its dedicated callback.
      record.mockImplementation(() => {
        throw new Error('closed ledger');
      });
      if (rejected)
        reject(
          new DuelLoopError('MODEL_INVALID', 'private provider text', { usage: result().usage }),
        );
      else resolve(result());
      await Promise.resolve();
      expect(record).toHaveBeenCalledTimes(1);
      expect(onLateResult).toHaveBeenCalledTimes(1);
      expect(model.lateResults[0]).toMatchObject({
        requestId: original[0]?.requestId,
        status: rejected ? 'failed' : 'succeeded',
        usage: result().usage,
      });
      expect(model.attempts).toEqual(original);
      expect(call).toHaveBeenCalledTimes(1);
      expect(model.lateLedgerFailed).toBe(false);
    },
  );

  it('retains late usage in memory and flags a failed late ledger without an unhandled rejection', async () => {
    const controller = new AbortController();
    let complete!: (response: Response) => void;
    const call = vi.fn<DecisionModel['score']>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const model = new AuditedDecisionModel(inner(call), () => {}, {
      onLateResult: () => {
        throw new Error('private ledger failure');
      },
    });
    const pending = model.score(request(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    complete(result());
    await Promise.resolve();
    expect(model.lateLedgerFailed).toBe(true);
    expect(model.lateResults[0]?.usage).toEqual(result().usage);
  });

  it('does not call a provider if the start record cannot be persisted', async () => {
    const call = vi.fn<DecisionModel['score']>();
    const model = new AuditedDecisionModel(inner(call), () => {}, {
      onStart: () => {
        throw new Error('private ledger failure');
      },
    });
    await expect(model.score(request())).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(call).not.toHaveBeenCalled();
    expect(model.attempts).toHaveLength(0);
  });

  it('does not reset the deadline between retries', async () => {
    const controller = new AbortController();
    const call = vi
      .fn<DecisionModel['score']>()
      .mockRejectedValue(new DuelLoopError('MODEL_TIMEOUT', 'timeout'));
    const model = new AuditedDecisionModel(inner(call), () => controller.abort());
    await expect(model.score(request(controller.signal))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'stops on ledger failure after a %s successful request',
    async (success) => {
      const call = vi.fn<DecisionModel['score']>();
      if (success) call.mockResolvedValue(result());
      else call.mockRejectedValue(new DuelLoopError('MODEL_INVALID', 'private', { status: 503 }));
      const model = new AuditedDecisionModel(inner(call), () => {
        throw new Error('private disk path');
      });
      await expect(model.score(request())).rejects.toMatchObject({
        code: 'STORAGE_FAILURE',
        message: 'Model attempt ledger write failed',
      });
      expect(call).toHaveBeenCalledTimes(1);
      expect(model.attempts).toHaveLength(1);
    },
  );

  it('pins retry configuration in behavior identity and rejects invalid settings', () => {
    const source = inner();
    const defaultModel = new AuditedDecisionModel(source, () => {});
    const zeroRetries = new AuditedDecisionModel(source, () => {}, { maxRetries: 0 });
    expect(defaultModel.behaviorIdentity).not.toEqual(source.behaviorIdentity);
    expect(defaultModel.behaviorIdentity).not.toEqual(zeroRetries.behaviorIdentity);
    expect(defaultModel.behaviorIdentity).toEqual(
      new AuditedDecisionModel(source, () => {}).behaviorIdentity,
    );
    for (const maxRetries of [-1, 0.5, 4, NaN]) {
      expect(() => new AuditedDecisionModel(source, () => {}, { maxRetries })).toThrow(
        'Retry count',
      );
    }
  });
});
