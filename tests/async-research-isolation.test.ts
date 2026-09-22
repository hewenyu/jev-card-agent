import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Worker } from 'node:worker_threads';
import { afterAll, expect, it, vi } from 'vitest';
import { JevProvider } from '../src/policies/jev.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { researchBatchHash, opponentKey } from '../src/knowledge/advice-validator.js';
import { KNOWLEDGE_CONTEXT_VERSION, RULESET_VERSION } from '../src/knowledge/validator.js';
import { loadAsyncResearchConfig } from '../src/research/config.js';
import { AsyncResearchService } from '../src/research/llm-service.js';
import { ResearchQueue } from '../src/research/queue.js';
import { Store } from '../src/storage/store.js';
import { arena, createRuntime, joined, send, turn } from './helpers/runtime-arena.js';
import type { DecisionTiming } from '../src/runtime/timing.js';

const results: Array<{
  scenario: string;
  researchRequests: number;
  timings: DecisionTiming[];
  bodyHashesEqual: boolean;
  totalMs: number;
}> = [];
const requestBodies = new Map<string, string[]>();
const samples = 30;
function batch(scope: string) {
  const key = opponentKey(scope);
  const at = new Date(Date.now() - 60000).toISOString();
  const content = {
    batchId: `batch-${scope}`,
    taskType: 'opponent_brief' as const,
    scopeKey: key,
    basePolicyVersion: baselineSnapshot().version,
    researchPromptVersion: 'test',
    inputSchemaVersion: 'research-batch-v2' as const,
    rulesetVersion: RULESET_VERSION,
    contextSchemaVersion: KNOWLEDGE_CONTEXT_VERSION,
    evidenceEventWatermark: 1,
    cutoff: at,
    eligibleHandIds: ['prior'],
    metrics: [
      {
        id: 'entry',
        name: 'Entry',
        numerator: 1,
        denominator: 1,
        opponentKey: key,
        handIds: ['prior'],
        throughEventId: 1,
        availableAt: at,
      },
    ],
    examples: [
      {
        id: 'ex',
        handId: 'prior',
        eventId: 1,
        availableAt: at,
        opponentKey: key,
        phase: 'post_settlement' as const,
        summary: 'Observed preflop entry.',
      },
    ],
    sampleDefinition: 'Controlled completed fixture',
    missingness: ['No showdown'],
    disclosureMode: 'public',
  };
  return { ...content, sourceSnapshotHash: researchBatchHash(content) };
}

it.each(['off', 'normal', 'hang', 'rate_limit', 'queue_full', 'worker_crash'] as const)(
  'accepts Jev actions over local WebSocket while asynchronous research is %s',
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-isolation-'));
    const raw = new Store(join(directory, 'raw.sqlite'));
    raw.beginRun({
      id: 'history',
      kind: 'live',
      strategy: 'jev',
      startedAt: new Date().toISOString(),
      config: {},
    });
    raw.saveDecisionBlock({
      runId: 'history',
      decisionId: 'retained-stop',
      reason: 'prior_failure',
      createdAt: new Date().toISOString(),
    });
    const pending = new Set<ServerResponse>();
    let calls = 0;
    const http = createServer((request, response) => {
      calls++;
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        expect(body).not.toContain('test-secret');
        if (['hang', 'queue_full', 'worker_crash'].includes(scenario)) {
          pending.add(response);
          response.on('close', () => pending.delete(response));
          return;
        }
        response.setHeader('content-type', 'application/json');
        if (scenario === 'rate_limit') {
          response.writeHead(429);
          response.end('{"error":"controlled-rate-limit"}');
          return;
        }
        response.end(
          JSON.stringify({
            id: 'controlled',
            status: 'completed',
            model: 'fixture-research',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: '{"status":"insufficient_evidence","reason":"Controlled fixture lacks enough completed evidence.","nextTrigger":"More completed hands."}',
                  },
                ],
              },
            ],
            usage: { input_tokens: 20, output_tokens: 10 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const config = loadAsyncResearchConfig(
      {
        ASYNC_LLM_MODE: scenario === 'off' ? 'off' : 'shadow',
        LLM_RESEARCH_PROVIDER: 'standard',
        LLM_RESEARCH_PROTOCOL: 'responses',
        LLM_RESEARCH_API_KEY: 'local-research-only',
        LLM_RESEARCH_MODEL: 'fixture-research',
        LLM_RESEARCH_BASE_URL: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
        LLM_RESEARCH_MAX_RETRIES: '0',
        LLM_RESEARCH_INTERVAL_MS: '10',
        LLM_RESEARCH_TIMEOUT_MS: '10000',
        LLM_RESEARCH_JOB_TIMEOUT_MS: '12000',
        LLM_RESEARCH_MAX_PENDING: '1',
      },
      raw.filename,
    );
    const queue = new ResearchQueue(config.databasePath);
    queue.enqueue(batch('first'), 'fixture-research', 1);
    const service = new AsyncResearchService(raw.filename, config);
    let runtime: ReturnType<typeof createRuntime>['runtime'] | undefined;
    try {
      await service.start();
      if (scenario !== 'off')
        await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 5000 });
      if (scenario === 'queue_full') {
        queue.enqueue(batch('second'), 'fixture-research', 1);
        queue.enqueue(batch('third'), 'fixture-research', 1);
        expect(queue.status().pending).toBe(1);
        expect(queue.status().runningJobs).toBe(1);
      }
      if (scenario === 'worker_crash') {
        const worker = (service as unknown as { worker: Worker | null }).worker!;
        await worker.terminate();
        await vi.waitFor(() => expect(service.status().error).toContain('Research worker failed'));
      }
      const bodies: string[] = [];
      requestBodies.set(scenario, bodies);
      const policy = new JevProvider({
        apiKey: 'local-jev-only',
        fetch: async (_url, init) => {
          bodies.push(String(init?.body));
          const input = JSON.parse(String(init?.body)) as {
            questions: { action: { criteria: Record<string, unknown> } };
          };
          const ids = Object.keys(input.questions.action.criteria);
          const selected = ids.includes('check') ? 'check' : ids[0]!;
          return new Response(
            JSON.stringify({
              model: 'jev-fixture',
              usage: { input_tokens: 10, output_tokens: 1 },
              answers: {
                action: {
                  type: 'choice',
                  choice: selected,
                  confidence: 1,
                  probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
                },
              },
            }),
          );
        },
      });
      let hands = 1;
      const urls = await arena((ws, message) => {
        if (message.type === 'join_lobby') {
          joined(ws);
          turn(ws, hands);
        }
        if (message.type === 'action') {
          send(ws, {
            type: 'action_ack',
            client_action_id: message.client_action_id,
            status: 'accepted',
          });
          send(ws, {
            type: 'hand_result',
            table_id: 't1',
            hand_id: `h${hands}`,
            table_seq: hands * 100 + 20,
          });
          if (hands < samples) {
            hands++;
            turn(ws, hands);
          }
        }
      });
      const local = createRuntime(urls, undefined, policy);
      runtime = local.runtime;
      const started = performance.now();
      await runtime.start({ strategy: 'jev' });
      await vi.waitFor(
        () =>
          expect(
            [...local.store.actions.values()].filter((action) => action.status === 'accepted'),
          ).toHaveLength(samples),
        { timeout: 6000, interval: 10 },
      );
      expect(local.store.blocks).toEqual([]);
      expect(local.store.decisions.every((decision) => decision.proposal.source === 'jev')).toBe(
        true,
      );
      expect(raw.loadDecisionBlock()?.decisionId).toBe('retained-stop');
      if (scenario === 'normal') await vi.waitFor(() => expect(queue.status().completed).toBe(1));
      if (scenario === 'rate_limit') await vi.waitFor(() => expect(queue.status().failed).toBe(1));
      if (['hang', 'queue_full'].includes(scenario)) expect(queue.status().runningJobs).toBe(1);
      const timings = local.store.decisions.map((decision) => structuredClone(decision.timing!));
      expect(timings.every((timing) => timing.firstSentAt !== undefined)).toBe(true);
      results.push({
        scenario,
        researchRequests: calls,
        timings,
        bodyHashesEqual:
          scenario === 'off' || JSON.stringify(bodies) === JSON.stringify(requestBodies.get('off')),
        totalMs: performance.now() - started,
      });
    } finally {
      runtime?.stop(false);
      await service.stop();
      for (const response of pending) response.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      queue.close();
      raw.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15000,
);

afterAll(() => {
  expect(results).toHaveLength(6);
  expect(results.every((result) => result.bodyHashesEqual)).toBe(true);
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;
  const summary = results.map((result) => ({
    scenario: result.scenario,
    samples: result.timings.length,
    researchRequests: result.researchRequests,
    bodyHashesEqual: result.bodyHashesEqual,
    totalMs: result.totalMs,
    metrics: Object.fromEntries(
      [
        'preparationMs',
        'knowledgeMs',
        'providerMs',
        'persistenceMs',
        'receiptToSendMs',
        'ackMs',
      ].map((key) => {
        const values = result.timings
          .map((timing) => (timing as unknown as Record<string, unknown>)[key])
          .filter((value): value is number => typeof value === 'number');
        return [
          key,
          {
            samples: values.length,
            p50: percentile(values, 0.5),
            p95: percentile(values, 0.95),
            p99: percentile(values, 0.99),
          },
        ];
      }),
    ),
  }));
  const destination = process.env.ASYNC_RESEARCH_PERFORMANCE_OUTPUT;
  if (destination) {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          environment: {
            platform: platform(),
            release: release(),
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
            node: process.version,
          },
          limitations: [
            'Controlled localhost WebSocket and mocked Jev fetch; not real Arena or provider latency.',
            'Thirty sequential hands per scenario, no statistical claim of equal performance.',
            'Runtime uses the existing in-memory WebSocket fixture store; raw SQLite backs the separate research worker only.',
            'State preparation and facts are included in preparationMs; they are not independently timed.',
            'No deployment or paid calls.',
          ],
          summary,
          raw: results,
        },
        null,
        2,
      ),
    );
  }
});
