import { AsyncLocalStorage } from 'node:async_hooks';
import { DuelLoopError, JevDecisionModel } from 'duelloop';

type Options = Omit<
  ConstructorParameters<typeof JevDecisionModel>[0],
  'fetch' | 'transportVersion'
>;
type Failure = { failureKind: 'http' | 'network'; status?: number; retryAfterMs?: number };
type RequestContext = { failure?: Failure };

const TRANSPORT_VERSION = 'poker-jev-safe-http-v1';
const HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Only a finite delay crosses the transport boundary, never the header text. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const delay = Number(text) * 1000;
    return Number.isFinite(delay) ? delay : undefined;
  }
  // Date.parse accepts arbitrary prose/numeric strings; only canonical HTTP dates qualify.
  if (!HTTP_DATE.test(text)) return undefined;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== text) return undefined;
  return Math.max(0, timestamp - now);
}

/** Public SDK adapter, with per-call safe metadata retained across its error sanitization. */
export function createReplayJevModel(options: Options): JevDecisionModel {
  const context = new AsyncLocalStorage<RequestContext>();
  const networkFailure = (signal?: AbortSignal | null): DuelLoopError => {
    const current = context.getStore();
    if (current && !signal?.aborted) current.failure = { failureKind: 'network' };
    return new DuelLoopError('MODEL_INVALID', 'Jev transport failed');
  };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      // A redirect must not move the credential-bearing request to another endpoint.
      response = await globalThis.fetch(input, { ...init, redirect: 'manual' });
    } catch {
      throw networkFailure(init?.signal);
    }
    if (response.ok) {
      if (!response.body) return response;
      // The SDK drains the body after fetch resolves. Preserve network classification
      // for a truncated response too, without buffering or parsing it a second time.
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              controller.close();
              reader.releaseLock();
            } else controller.enqueue(result.value);
          } catch {
            controller.error(networkFailure(init?.signal));
            reader.releaseLock();
          }
        },
        cancel() {
          return reader.cancel().catch(() => {});
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    const failure: Failure = {
      failureKind: 'http',
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    const current = context.getStore();
    if (current) current.failure = failure;
    // Do not read a failure body or let the SDK preserve arbitrary headers/provider text.
    void response.body?.cancel().catch(() => {});
    throw new DuelLoopError('MODEL_INVALID', 'Jev HTTP request failed', failure);
  };
  const call = <T>(operation: () => Promise<T>): Promise<T> =>
    context.run({}, async () => {
      try {
        return await operation();
      } catch (error) {
        const failure = context.getStore()?.failure;
        // SDK timeout/cancellation identities take precedence over transport failures.
        if (failure && error instanceof DuelLoopError && error.code === 'MODEL_INVALID') {
          throw new DuelLoopError('MODEL_INVALID', 'Jev transport request failed', {
            ...failure,
            usage: { unknown: true },
            usageUnknown: true,
          });
        }
        throw error;
      }
    });
  class ReplayJevModel extends JevDecisionModel {
    override score(request: Parameters<JevDecisionModel['score']>[0]) {
      return call(() => super.score(request));
    }

    override choice(request: Parameters<JevDecisionModel['choice']>[0]) {
      return call(() => super.choice(request));
    }
  }
  return new ReplayJevModel({ ...options, fetch, transportVersion: TRANSPORT_VERSION });
}
