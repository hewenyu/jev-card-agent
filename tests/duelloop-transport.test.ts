import { createServer, type RequestListener, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuelLoopError } from 'duelloop';
import { afterEach, describe, expect, it } from 'vitest';
import { createReplayJevModel, parseRetryAfter } from '../src/duelloop/transport.js';
import { AuditedDecisionModel } from '../src/duelloop/model.js';
import { appendLedger } from '../src/duelloop/ledger.js';

const servers: Server[] = [];
const directories: string[] = [];
async function endpoint(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function request(signal = new AbortController().signal) {
  return {
    state: { pot: 40 },
    questions: [
      {
        id: 'quality',
        actionId: 'call',
        dimensionId: 'quality',
        instructions: 'Evaluate calling.',
        criteria: ['weak', 'strong'],
      },
    ],
    signal,
  };
}
const success = {
  model: 'jev-test',
  usage: { input_tokens: 4, output_tokens: 2 },
  answers: {
    quality: { type: 'score', score: 1, confidence: 1, probabilities: { 0: 0, 1: 1 } },
  },
};

describe('DuelLoop public Jev transport', () => {
  it('recovers from a real 100 ms rate limit inside the original one-second window', async () => {
    const calledAt: number[] = [];
    const baseURL = await endpoint((_req, res) => {
      calledAt.push(performance.now());
      if (calledAt.length === 1) res.writeHead(429, { 'Retry-After': '0.1' }).end();
      else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(success));
      }
    });
    const inner = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    const model = new AuditedDecisionModel(inner, () => {});
    await expect(model.score(request(AbortSignal.timeout(1000)))).resolves.toMatchObject({
      model: 'jev-test',
    });
    expect(calledAt).toHaveLength(2);
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(100);
    expect(model.attempts[0]).toMatchObject({
      httpStatus: 429,
      retryAfterMs: 100,
      failureKind: 'http',
    });
  });

  it('recovers after two real HTTP 403 responses with each failed attempt persisted before retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-403-retry-'));
    directories.push(directory);
    const ledger = join(directory, 'attempts.jsonl');
    const persistedBeforeRequest: number[] = [];
    const baseURL = await endpoint((_req, res) => {
      persistedBeforeRequest.push(
        existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').length : 0,
      );
      if (persistedBeforeRequest.length < 3) res.writeHead(403).end('private gateway error');
      else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(success));
      }
    });
    const inner = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    const model = new AuditedDecisionModel(inner, (attempt) => appendLedger(ledger, attempt));
    await expect(model.score(request(AbortSignal.timeout(3000)))).resolves.toMatchObject({
      model: 'jev-test',
      answers: { quality: { score: 1 } },
      usage: { unknown: true },
    });
    expect(persistedBeforeRequest).toEqual([0, 1, 2]);
    const attempts = readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(attempts).toEqual(model.attempts);
    expect(attempts).toMatchObject([
      { retryIndex: 0, status: 'failed', httpStatus: 403, failureKind: 'http' },
      { retryIndex: 1, status: 'failed', httpStatus: 403, failureKind: 'http' },
      { retryIndex: 2, status: 'succeeded' },
    ]);
    expect(new Set(model.attempts.map((attempt) => attempt.requestHash)).size).toBe(1);
    expect(readFileSync(ledger, 'utf8')).not.toContain('private gateway error');
  });

  it('terminates after three real HTTP 403 failures without issuing a fourth request', async () => {
    let calls = 0;
    const baseURL = await endpoint((_req, res) => {
      calls++;
      res.writeHead(403).end();
    });
    const inner = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    const model = new AuditedDecisionModel(inner, () => {});
    await expect(model.score(request(AbortSignal.timeout(3000)))).rejects.toMatchObject({
      code: 'MODEL_INVALID',
      context: { status: 403, usage: { unknown: true } },
    });
    expect(calls).toBe(3);
    expect(model.attempts).toMatchObject([
      { retryIndex: 0, status: 'failed', httpStatus: 403 },
      { retryIndex: 1, status: 'failed', httpStatus: 403 },
      { retryIndex: 2, status: 'failed', httpStatus: 403 },
    ]);
  });

  it.each([429, 403])(
    'never retries HTTP %i before a server delay that exceeds the shared deadline',
    async (status) => {
      let calls = 0;
      const baseURL = await endpoint((_req, res) => {
        calls++;
        res.writeHead(status, { 'Retry-After': '1' }).end();
      });
      const inner = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
      const model = new AuditedDecisionModel(inner, () => {});
      await expect(model.score(request(AbortSignal.timeout(150)))).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      expect(calls).toBe(1);
      expect(model.attempts).toMatchObject([{ httpStatus: status, retryAfterMs: 1000 }]);
    },
  );

  it('isolates error metadata between simultaneous calls on one public adapter', async () => {
    let calls = 0;
    const baseURL = await endpoint((_req, res) => {
      const index = ++calls;
      setTimeout(
        () => res.writeHead(index === 1 ? 429 : 503, { 'Retry-After': String(index) }).end(),
        index === 1 ? 30 : 0,
      );
    });
    const model = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    const errors = await Promise.all(
      [model.score(request()), model.score(request())].map((result) =>
        result.catch((error: DuelLoopError) => error),
      ),
    );
    expect(errors[0]).toMatchObject({ context: { status: 429, retryAfterMs: 1000 } });
    expect(errors[1]).toMatchObject({ context: { status: 503, retryAfterMs: 2000 } });
  });

  it.each([
    [429, '0.1', 100],
    [503, '2', 2000],
    [403, '0.2', 200],
    [401, '5', 5000],
    [429, 'bad-provider-secret', undefined],
    [429, undefined, undefined],
  ])(
    'preserves only safe failure metadata for HTTP %i and Retry-After %s',
    async (status, header, delay) => {
      let calls = 0;
      const baseURL = await endpoint((_req, res) => {
        calls++;
        res.statusCode = status;
        if (header) res.setHeader('Retry-After', header);
        res.setHeader('x-private-secret', 'header-secret');
        res.end('private-state-and-provider-secret');
      });
      const model = createReplayJevModel({ model: 'jev-test', apiKey: 'test-credential', baseURL });
      const error = await model.score(request()).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(DuelLoopError);
      expect(error).toMatchObject({
        code: 'MODEL_INVALID',
        context: { failureKind: 'http', status, usage: { unknown: true } },
      });
      expect((error as DuelLoopError).context.retryAfterMs).toBe(delay);
      expect(Object.keys((error as DuelLoopError).context).sort()).toEqual(
        [
          'failureKind',
          'status',
          'usage',
          'usageUnknown',
          ...(delay === undefined ? [] : ['retryAfterMs']),
        ].sort(),
      );
      expect(JSON.stringify(error)).not.toMatch(/secret|credential|private-state|headers|cause/);
      // The public SDK does not perform additional attempts beneath the audited retry layer.
      expect(calls).toBe(1);
    },
  );

  it('preserves a configured proxy path and handles a normal public SDK response', async () => {
    let path: string | undefined;
    const baseURL = await endpoint((req, res) => {
      path = req.url;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(success));
    });
    const model = createReplayJevModel({
      model: 'jev-test',
      apiKey: 'test',
      baseURL: `${baseURL}/proxy`,
    });
    await expect(model.score(request())).resolves.toMatchObject({
      model: 'jev-test',
      answers: { quality: { score: 1 } },
    });
    expect(path).toBe('/proxy/v1/systemone');
  });

  it('retains HTTP date delays through the public SDK', async () => {
    const future = new Date(Date.now() + 30000).toUTCString();
    const baseURL = await endpoint((_req, res) => {
      res.writeHead(429, { 'Retry-After': future }).end();
    });
    const before = Date.now();
    const model = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    const error = await model.score(request()).catch((failure: DuelLoopError) => failure);
    expect(error).toBeInstanceOf(DuelLoopError);
    const delay = Number((error as DuelLoopError).context.retryAfterMs);
    expect(delay).toBeGreaterThanOrEqual(Date.parse(future) - Date.now());
    expect(delay).toBeLessThanOrEqual(Date.parse(future) - before);
  });

  it('does not forward credentials on redirects', async () => {
    let forwarded = 0;
    const redirect = await endpoint((_req, res) => {
      forwarded++;
      res.end(JSON.stringify(success));
    });
    const baseURL = await endpoint((_req, res) => res.writeHead(307, { Location: redirect }).end());
    const model = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    await expect(model.score(request())).rejects.toMatchObject({
      context: { status: 307, failureKind: 'http' },
    });
    expect(forwarded).toBe(0);
  });

  it('classifies connection loss without recording socket errors', async () => {
    const baseURL = await endpoint((req) => req.socket.destroy());
    const model = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    await expect(model.score(request())).rejects.toMatchObject({
      code: 'MODEL_INVALID',
      context: { failureKind: 'network', usage: { unknown: true } },
    });
  });

  it('classifies connection loss after successful response headers as a network failure', async () => {
    const baseURL = await endpoint((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '10000' });
      res.write('{');
      setTimeout(() => res.destroy(), 10);
    });
    const model = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    await expect(model.score(request())).rejects.toMatchObject({
      code: 'MODEL_INVALID',
      context: { failureKind: 'network' },
    });
  });

  it.each(['timeout', 'cancel'] as const)('preserves the SDK %s identity', async (mode) => {
    let received!: () => void;
    const pending = new Promise<void>((resolve) => {
      received = resolve;
    });
    const baseURL = await endpoint(() => received());
    const signal = new AbortController();
    const model = createReplayJevModel({
      model: 'jev-test',
      apiKey: 'test',
      baseURL,
      timeoutMs: mode === 'timeout' ? 75 : 1000,
    });
    const result = model.score(request(signal.signal));
    const assertion = expect(result).rejects.toMatchObject({
      code: mode === 'timeout' ? 'MODEL_TIMEOUT' : 'CANCELLED',
    });
    await pending;
    if (mode === 'cancel') signal.abort();
    await assertion;
  });

  it('does not relabel malformed successful output as a network failure', async () => {
    const baseURL = await endpoint((_req, res) => res.end('{}'));
    const model = createReplayJevModel({ model: 'jev-test', apiKey: 'test', baseURL });
    const error = await model.score(request()).catch((failure: DuelLoopError) => failure);
    expect(error).toMatchObject({ code: 'MODEL_INVALID' });
    expect((error as DuelLoopError).context.failureKind).toBeUndefined();
  });
});

describe('Retry-After numeric boundary', () => {
  it.each([
    '-1',
    'NaN',
    'Infinity',
    '1e3',
    '12/31/2099',
    '0.1 private',
    '9'.repeat(400),
    'Wed, 31 Feb 2027 00:00:00 GMT',
  ])('rejects malformed value %s', (value) => {
    expect(parseRetryAfter(value)).toBeUndefined();
  });
  it('clamps past HTTP dates to zero', () => {
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:00 GMT')).toBe(0);
  });
});
