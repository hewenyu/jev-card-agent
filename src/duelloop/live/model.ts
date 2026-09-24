import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AuditedDecisionModel,
  type ModelAttempt,
  type ModelAttemptStart,
  type LateModelResult,
} from '../model.js';
import { createReplayJevModel } from '../transport.js';
import { sdkBaseUrl } from '../config.js';

const deadlines = new AsyncLocalStorage<{ deadline: number; contextId?: string }>();

export function withModelDeadline<T>(
  deadline: number,
  operation: () => Promise<T>,
  contextId?: string,
): Promise<T> {
  if (!Number.isFinite(deadline)) throw new Error('An absolute model deadline is required');
  return deadlines.run({ deadline, contextId }, operation);
}

export const modelContextId = (): string | undefined => deadlines.getStore()?.contextId;

/** Live and independent evaluation use the exact same adapter and retry identity. */
export function createLiveModel(
  options: { apiKey: string; baseUrl: string; model: string; timeoutMs: number },
  hooks: {
    onStart?: (attempt: ModelAttemptStart) => void;
    onAttempt: (attempt: ModelAttempt) => void;
    onLateResult?: (attempt: LateModelResult) => void;
  },
): AuditedDecisionModel {
  return new AuditedDecisionModel(
    createReplayJevModel({
      apiKey: options.apiKey,
      baseURL: sdkBaseUrl(options.baseUrl),
      model: options.model,
      timeoutMs: options.timeoutMs,
    }),
    hooks.onAttempt,
    {
      maxRetries: 3,
      deadlineAt: () => {
        const deadline = deadlines.getStore()?.deadline;
        if (deadline === undefined) throw new Error('Missing frozen model deadline');
        return deadline;
      },
      onStart: hooks.onStart,
      onLateResult: hooks.onLateResult,
    },
  );
}
