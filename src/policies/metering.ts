import { randomUUID } from 'node:crypto';
import type { ProviderAttempt, ProviderCall, ProviderMeter } from '../core/types.js';

export class ProviderError extends Error {
  attempts?: ProviderAttempt[];
  constructor(
    public readonly code: string,
    public readonly attempt?: ProviderAttempt,
  ) {
    super(code);
    this.name = 'ProviderError';
  }
}
export class ProviderLedgerError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : 'Provider ledger failed', { cause: error });
    this.name = 'ProviderLedgerError';
  }
}
export function beginAttempt(call: ProviderCall, meter?: ProviderMeter) {
  let reservationId: string | null | undefined;
  try {
    reservationId = meter ? meter.before(call) : undefined;
  } catch (error) {
    throw new ProviderLedgerError(error);
  }
  if (reservationId === null) throw new ProviderError('provider_input_too_large');
  const started = performance.now();
  const attempt: ProviderAttempt = {
    id: randomUUID(),
    provider: call.provider,
    purpose: call.purpose,
    requestedModel: call.requestedModel,
    actualModel: null,
    status: 'failed',
    usage: null,
    latencyMs: 0,
  };
  let settled = false;
  return {
    attempt,
    finish(status: ProviderAttempt['status'], errorCode?: string): ProviderAttempt {
      attempt.status = status;
      attempt.errorCode = errorCode;
      attempt.latencyMs = Math.round(performance.now() - started);
      if (!settled) {
        settled = true;
        if (meter && reservationId !== undefined) {
          try {
            meter.after(attempt, reservationId);
          } catch (error) {
            throw new ProviderLedgerError(error);
          }
        }
      }
      return structuredClone(attempt);
    },
  };
}
export function endpoint(baseUrl: string, resource: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('API base URL must not include credentials, a query or fragment');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('API base URL must use HTTPS (HTTP allowed only for local tests)');
  const root = baseUrl.replace(/\/+$/, '');
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/${resource}`;
}
