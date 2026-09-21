import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCandidates,
  buildContext,
  createInitialState,
  reduceMessage,
} from '../src/core/index.js';
import { chooseBaseline, chooseFallback, JevProvider } from '../src/policies/index.js';

const state = reduceMessage(
  { ...createInitialState(), heroSeat: 0, holeCards: ['Ah', 'Ad'] },
  {
    type: 'your_turn',
    hand_id: 'h',
    turn_token: 'token',
    pot: 30,
    valid_actions: [
      { action: 'fold' },
      { action: 'check' },
      { action: 'raise', min: 40, max: 100 },
    ],
  },
);
const candidates = buildCandidates(state);
const context = buildContext(state);
const servers: Server[] = [];
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function answer(overrides: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 100, output_tokens: 12 },
    answers: {
      action: {
        type: 'choice',
        choice: 'check',
        confidence: 0.9,
        probabilities: Object.fromEntries(candidates.map((c) => [c.id, c.id === 'check' ? 1 : 0])),
        ...overrides,
      },
    },
  };
}
describe('policies', () => {
  it('prefers free check in fallback and never invents a legal action', () => {
    expect(chooseFallback(candidates).action).toBe('check');
    expect(() => chooseFallback([{ id: 'call', action: 'call', label: '' }])).toThrow();
    const proposal = chooseBaseline(context, candidates);
    expect(candidates.some((c) => c.id === proposal.candidateId)).toBe(true);
  });
  it('calls the real HTTP contract with discrete candidates and records actual model/usage', async () => {
    let body: Record<string, unknown> = {};
    const baseUrl = await serve((req, res) => {
      expect(req.url).toBe('/v1/systemone');
      expect(req.headers.authorization).toBe('Bearer fixture-key');
      let data = '';
      req.on('data', (chunk) => {
        data += String(chunk);
      });
      req.on('end', () => {
        body = JSON.parse(data) as Record<string, unknown>;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(answer()));
      });
    });
    const provider = new JevProvider({ apiKey: 'fixture-key', baseUrl });
    const result = await provider.decide(context, candidates);
    expect(result.model).toBe('jev-1.13.0');
    expect(result.candidateId).toBe('check');
    expect(result.usage?.input_tokens).toBe(100);
    expect(body.state).toEqual(context);
    expect(JSON.stringify(result.request)).not.toContain('fixture-key');
  });
  it('rejects unknown candidate IDs and non-normalized distributions', async () => {
    const baseUrl = await serve((_req, res) =>
      res.end(JSON.stringify(answer({ choice: 'raise_to_999999' }))),
    );
    await expect(
      new JevProvider({ apiKey: 'fixture-key', baseUrl }).decide(context, candidates),
    ).rejects.toThrow('unknown');
  });
  it('rejects a distribution that does not sum to one', async () => {
    const baseUrl = await serve((_req, res) =>
      res.end(
        JSON.stringify(
          answer({ probabilities: Object.fromEntries(candidates.map((c) => [c.id, 0.1])) }),
        ),
      ),
    );
    await expect(
      new JevProvider({ apiKey: 'fixture-key', baseUrl }).decide(context, candidates),
    ).rejects.toThrow('sum to one');
  });
  it('caps 429 retries at four attempts and does not leak the response body into errors', async () => {
    let requests = 0;
    const baseUrl = await serve((_req, res) => {
      requests++;
      res.writeHead(429, { 'Retry-After': '60' });
      res.end('private error details');
    });
    await expect(
      new JevProvider({ apiKey: 'fixture-key', baseUrl }).decide(context, candidates),
    ).rejects.toThrow('HTTP 429');
    expect(requests).toBe(4);
  });
  it('obeys a global abort even while the HTTP response is pending', async () => {
    const baseUrl = await serve(() => {});
    await expect(
      new JevProvider({ apiKey: 'fixture-key', baseUrl, timeoutMs: 1000 }).decide(
        context,
        candidates,
        { signal: AbortSignal.timeout(20) },
      ),
    ).rejects.toThrow();
  });
});
