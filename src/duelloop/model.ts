import { randomUUID } from 'node:crypto';
import {
  DuelLoopError,
  digest,
  validateScoreAnswer,
  type DecisionModel,
  type ErrorCode,
  type ModelUsage,
} from 'duelloop';
import { RETRY_POLICY, retryDelay, waitForRetry, type RetryFailure } from './retry.js';
import { normalizeUsage as usage, accumulateUsage as accumulate, emptyUsage } from './usage.js';

type ScoreRequest = Parameters<DecisionModel['score']>[0];
type ScoreResponse = Awaited<ReturnType<DecisionModel['score']>>;

export interface ModelAttemptStart {
  requestId: string;
  requestHash: string;
  retryIndex: number;
  startedAt: string;
}

export interface ModelAttempt extends ModelAttemptStart {
  latencyMs: number;
  status: 'succeeded' | 'failed';
  code?: ErrorCode;
  httpStatus?: number;
  failureKind?: RetryFailure['failureKind'];
  retryAfterMs?: number;
  usage: ModelUsage;
  actualModel?: string;
}

export interface LateModelResult extends ModelAttempt {
  receivedAt: string;
}

export interface AuditedModelOptions {
  maxRetries?: number;
  /** Absolute SDK model deadline; read once per score call, never renewed by a retry. */
  deadlineAt?: () => number;
  onStart?: (attempt: ModelAttemptStart) => void;
  onLateResult?: (result: LateModelResult) => void;
}

interface AttemptOutcome {
  response?: ScoreResponse;
  error?: ReturnType<typeof failure>;
  usage: ModelUsage;
  storageFailed?: boolean;
}

function failure(error: unknown, signal: AbortSignal): RetryFailure {
  if (signal.aborted) return { code: 'CANCELLED' };
  if (!(error instanceof DuelLoopError)) return { code: 'MODEL_INVALID' };
  const status = error.context.status;
  const failureKind = error.context.failureKind;
  const retryAfterMs = error.context.retryAfterMs;
  return {
    code: error.code,
    ...(Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599
      ? { httpStatus: Number(status) }
      : {}),
    ...(failureKind === 'network' || failureKind === 'http' ? { failureKind } : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? { retryAfterMs }
      : {}),
  };
}

function validate(response: ScoreResponse, request: ScoreRequest, model: DecisionModel): void {
  if (!response || typeof response.model !== 'string' || !response.model.length) {
    throw new DuelLoopError('MODEL_INVALID', 'Model response identity is missing');
  }
  if (response.model !== model.id && model.kind !== 'fixture') {
    throw new DuelLoopError(
      'VERSION_INCOMPATIBLE',
      'Model response identity differs from its binding',
    );
  }
  if (
    !response.answers ||
    typeof response.answers !== 'object' ||
    Array.isArray(response.answers) ||
    Object.keys(response.answers).length !== request.questions.length
  ) {
    throw new DuelLoopError('MODEL_INVALID', 'Model response has invalid answers');
  }
  for (const question of request.questions) {
    const answer = Object.hasOwn(response.answers, question.id)
      ? response.answers[question.id]
      : undefined;
    validateScoreAnswer(answer, question.criteria.length);
  }
}

/** Shared-deadline retries with a synchronous durable ledger boundary between calls. */
export class AuditedDecisionModel implements DecisionModel {
  readonly id: string;
  readonly kind: DecisionModel['kind'];
  readonly behaviorIdentity: DecisionModel['behaviorIdentity'];
  readonly attempts: ModelAttempt[] = [];
  readonly lateResults: LateModelResult[] = [];
  #lateLedgerFailed = false;
  readonly #maxRetries: number;

  get lateLedgerFailed(): boolean {
    return this.#lateLedgerFailed;
  }

  constructor(
    private readonly inner: DecisionModel,
    private readonly record: (attempt: ModelAttempt) => void,
    private readonly options: AuditedModelOptions = {},
  ) {
    this.#maxRetries = options.maxRetries ?? 3;
    if (!Number.isInteger(this.#maxRetries) || this.#maxRetries < 0 || this.#maxRetries > 3) {
      throw new DuelLoopError(
        'CONFIG_INVALID',
        'Retry count must be an integer from zero through three',
      );
    }
    this.id = inner.id;
    this.kind = inner.kind;
    this.behaviorIdentity = Object.freeze({
      ...inner.behaviorIdentity,
      adapterVersion: `poker-audited-score-v3/${inner.behaviorIdentity.adapterVersion}`,
      configurationDigest: digest({
        inner: inner.behaviorIdentity,
        maxRetries: this.#maxRetries,
        sharedDeadline: true,
        wallclockDeadlineGuard: options.deadlineAt ? 'frozen-before-provider-v1' : 'signal-only',
        retryPolicy: RETRY_POLICY,
        accountingVersion: 'cancelled-unknown-with-separate-late-usage-v3',
      }),
    });
  }

  async score(request: ScoreRequest): Promise<ScoreResponse> {
    const total = emptyUsage();
    let deadlineAt: number | undefined;
    try {
      deadlineAt = this.options.deadlineAt?.();
      if (this.options.deadlineAt && !Number.isFinite(deadlineAt)) throw new Error();
    } catch {
      throw new DuelLoopError('CONFIG_INVALID', 'Model deadline must be a finite timestamp', {
        usage: total,
      });
    }
    const guard = () => {
      if (request.signal.aborted)
        throw new DuelLoopError('CANCELLED', 'Model request cancelled', { usage: total });
      if (deadlineAt !== undefined && Date.now() >= deadlineAt)
        throw new DuelLoopError('MODEL_TIMEOUT', 'Model deadline expired before submission', {
          usage: total,
        });
    };
    guard();
    const requestHash = digest({
      model: this.id,
      state: request.state,
      questions: request.questions,
    });
    for (let retryIndex = 0; retryIndex <= this.#maxRetries; retryIndex++) {
      guard();
      const started: ModelAttemptStart = {
        requestId: randomUUID(),
        requestHash,
        retryIndex,
        startedAt: new Date().toISOString(),
      };
      try {
        this.options.onStart?.(structuredClone(started));
      } catch {
        throw new DuelLoopError('STORAGE_FAILURE', 'Model start ledger write failed', {
          usage: total,
        });
      }
      // Synchronous fsync can outlast a deadline while delaying the abort timer.
      // Its start record is an intent; no attempt is counted before provider submission.
      guard();
      const outcome = await this.attempt(request, started);
      accumulate(total, outcome.usage);
      if (outcome.storageFailed) {
        throw new DuelLoopError('STORAGE_FAILURE', 'Model attempt ledger write failed', {
          usage: total,
        });
      }
      const { response, error } = outcome;
      if (!error) return { ...response!, usage: total };
      const delayMs = retryDelay(error, retryIndex);
      if (delayMs === null || retryIndex === this.#maxRetries) {
        throw new DuelLoopError(error.code, 'Audited model request failed', {
          ...(error.httpStatus === undefined ? {} : { status: error.httpStatus }),
          usage: total,
        });
      }
      if (!(await waitForRetry(delayMs, request.signal))) {
        throw new DuelLoopError('CANCELLED', 'Model request cancelled during retry delay', {
          usage: total,
        });
      }
    }
    throw new DuelLoopError('MODEL_INVALID', 'Model retry loop ended without a result');
  }

  private attempt(request: ScoreRequest, started: ModelAttemptStart): Promise<AttemptOutcome> {
    const start = performance.now();
    return new Promise((resolve) => {
      let finished = false;
      let cancelled = false;
      const record = (outcome: AttemptOutcome): ModelAttempt => ({
        ...started,
        latencyMs: performance.now() - start,
        status: outcome.error ? 'failed' : 'succeeded',
        ...outcome.error,
        usage: outcome.usage,
        // Unexpected provider text, including model names, must not enter the ledger.
        ...(outcome.response?.model === this.id ? { actualModel: this.id } : {}),
      });
      const finish = (outcome: AttemptOutcome) => {
        if (finished) {
          if (!cancelled) return;
          const late: LateModelResult = {
            ...record(outcome),
            receivedAt: new Date().toISOString(),
          };
          this.lateResults.push(structuredClone(late));
          try {
            this.options.onLateResult?.(structuredClone(late));
          } catch {
            this.#lateLedgerFailed = true;
          }
          return;
        }
        finished = true;
        request.signal.removeEventListener('abort', abort);
        const attempt = record(outcome);
        this.attempts.push(structuredClone(attempt));
        try {
          this.record(structuredClone(attempt));
        } catch {
          outcome.storageFailed = true;
        }
        resolve(outcome);
      };
      const abort = () => {
        cancelled = true;
        // This write occurs synchronously in the abort listener, before an outer deadline
        // race can return and close its ledger. A late response never rewrites this record.
        finish({ error: { code: 'CANCELLED' }, usage: usage(undefined) });
      };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) {
        abort();
        return;
      }
      const failed = (error: unknown) =>
        finish({
          error: failure(error, request.signal),
          usage: usage(error instanceof DuelLoopError ? error.context.usage : undefined),
        });
      try {
        const pending = this.inner.score(request);
        void pending.then((response) => {
          const outcome: AttemptOutcome = { response, usage: usage(response?.usage) };
          try {
            validate(response, request, this.inner);
          } catch (error) {
            outcome.error = failure(error, request.signal);
          }
          finish(outcome);
        }, failed);
      } catch (error) {
        failed(error);
      }
    });
  }
}
