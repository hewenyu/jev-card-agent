import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { evaluateRun } from '../evaluation/service.js';
import { Store } from '../storage/store.js';
import { redact } from '../storage/database.js';
import type { AppConfig } from './config.js';
import { isLoopback } from './config.js';
import { Controller, policyFor, ledgerFor } from './controller.js';

declare module 'fastify' {
  interface FastifyInstance {
    controller: Controller;
  }
}

const startSchema = z
  .object({
    strategy: z.enum(['jev', 'baseline', 'jev-reasoning']).default('jev'),
    buyIn: z.number().int().min(1000).max(5000).default(2000),
    maxHands: z.number().int().min(0).max(1_000_000).default(0),
    maxMinutes: z.number().min(0).max(525_600).default(0),
    budgetUsd: z.number().min(0).max(100).default(1),
    autoRebuy: z.boolean().default(true),
  })
  .strict();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().min(1).optional(),
});
const evalSchema = z
  .object({
    runId: z.string().min(1),
    strategy: z.enum(['jev', 'baseline', 'jev-reasoning']).default('baseline'),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
function sameToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function buildApp(config: AppConfig, options: { store?: Store } = {}) {
  if (!isLoopback(config.host) && !config.apiToken && !config.readOnlyDemo)
    throw new Error('Public binding requires authentication');
  if (config.publicHistory && !config.apiToken && !config.readOnlyDemo)
    throw new Error('PUBLIC_HISTORY requires API_TOKEN');
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  const store = options.store ?? new Store(config.databasePath, config.jevModel);
  const controller = new Controller(config, store);
  app.decorate('controller', controller);
  let evaluating = false;
  const publicViewers = new WeakSet<object>();
  const completedHand = (id: string) =>
    store.db.prepare("SELECT id FROM hands WHERE id=? AND status='complete'").get(id) !== undefined;
  app.addHook('onRequest', async (request, reply) => {
    // Fastify matches decoded paths, so authorize the matched route rather than the raw URL.
    const isApi = request.routeOptions.url?.startsWith('/api/') ?? false;
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', isApi ? 'no-store' : 'no-cache');
    if (!isApi) return;
    const authorization = request.headers.authorization;
    if (
      authorization !== undefined &&
      (!config.apiToken || !sameToken(authorization, config.apiToken))
    ) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    if (config.publicHistory && authorization === undefined) {
      publicViewers.add(request);
      if (request.method !== 'GET')
        return reply.code(403).send({ error: 'Public history is read-only' });
    } else if (config.apiToken && authorization === undefined) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const hostname = request.hostname;
    if (isLoopback(config.host) && !config.apiToken && !isLoopback(hostname)) {
      return reply.code(403).send({ error: 'Untrusted Host header' });
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (config.readOnlyDemo) return reply.code(403).send({ error: 'This demo is read-only' });
      const origin = request.headers.origin;
      if (origin) {
        let valid = false;
        try {
          const source = new URL(origin);
          valid =
            source.host === request.host ||
            (isLoopback(config.host) && isLoopback(source.hostname));
        } catch {
          /* Invalid origins are forbidden. */
        }
        if (!valid) return reply.code(403).send({ error: 'Cross-site mutation denied' });
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      });
    const status =
      typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 400;
    return reply
      .code(status >= 400 && status < 600 ? status : 400)
      .send({ error: error instanceof Error ? error.message : 'Request failed' });
  });
  app.get('/health', () => ({ status: 'ok', service: 'jev-card-agent' }));
  app.get('/api/overview', (request) => {
    const overview = controller.overview();
    if (!publicViewers.has(request)) return overview;
    return redact({
      ...overview,
      runtime: { ...overview.runtime, table: null, error: null },
      runs: overview.runs.map((run) => ({ ...run, reason: null })),
      recentHands: overview.recentHands.filter((hand) => hand.status === 'complete'),
      capabilities: {
        canControl: false,
        liveConfigured: false,
        jevConfigured: false,
        reasoningConfigured: false,
      },
    });
  });
  app.get('/api/runs', (request) => {
    const runs = controller.queries.runs(pageSchema.parse(request.query));
    return publicViewers.has(request) ? runs.map((run) => ({ ...run, reason: null })) : runs;
  });
  app.get('/api/hands', (request) => {
    const query = pageSchema.extend({ runId: z.string().optional() }).parse(request.query);
    return controller.queries.hands(query.runId, {
      ...query,
      completedOnly: publicViewers.has(request),
    });
  });
  app.get('/api/hands/:id', (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (publicViewers.has(request) && !completedHand(id))
      return reply.code(404).send({ error: 'Hand not found' });
    const result = controller.queries.hand(id);
    return result
      ? publicViewers.has(request)
        ? redact(result)
        : result
      : reply.code(404).send({ error: 'Hand not found' });
  });
  app.get('/api/decisions/:id', (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = controller.queries.decision(id);
    if (!result || (publicViewers.has(request) && !completedHand(result.handId)))
      return reply.code(404).send({ error: 'Decision not found' });
    return publicViewers.has(request) ? redact(result) : result;
  });
  app.get('/api/evaluations', (request) =>
    publicViewers.has(request) ? [] : controller.queries.evaluations(),
  );
  app.post('/api/runtime/start', async (request) =>
    controller.start(startSchema.parse(request.body ?? {})),
  );
  app.post('/api/runtime/stop', () => controller.stop());
  app.post('/api/demo/reset', () => {
    controller.resetDemo();
    return controller.overview();
  });
  app.post('/api/evaluations', async (request, reply) => {
    const input = evalSchema.parse(request.body);
    if (!store.db.prepare('SELECT id FROM runs WHERE id=?').get(input.runId))
      return reply.code(404).send({ error: 'Run not found' });
    if (evaluating) return reply.code(409).send({ error: 'An evaluation is already running' });
    if (input.strategy !== 'baseline' && !config.jevApiKey)
      return reply.code(400).send({ error: 'JEV_API_KEY is required' });
    if (input.strategy === 'jev-reasoning' && !config.reasoningApiKey)
      return reply.code(400).send({ error: 'REASONING_API_KEY is required' });
    const evaluationId = randomUUID();
    const meter =
      input.strategy === 'jev-reasoning'
        ? ledgerFor(config, store, `evaluation-${evaluationId}`)
        : undefined;
    evaluating = true;
    try {
      return await evaluateRun(
        store,
        input.runId,
        input.strategy,
        input.limit,
        policyFor(config, input.strategy, meter),
        input.strategy === 'jev' ? controller.budget : undefined,
        {
          id: evaluationId,
          timeoutMs:
            input.strategy === 'jev-reasoning' ? config.hybridTimeoutMs : config.jevTimeoutMs,
        },
      );
    } finally {
      evaluating = false;
    }
  });
  if (existsSync(join(config.staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.staticRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/'))
        return reply.code(404).send({ error: 'Route not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: 'Route not found; run npm run build to serve the console' }),
    );
  }
  app.addHook('onClose', async () => {
    await controller.close();
    if (!options.store) store.close();
  });
  return app;
}
