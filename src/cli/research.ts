import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { argumentsFor, fail, numberArg } from './args.js';
import { loadConfig } from '../server/config.js';
import { EvidenceBuilder } from '../research/evidence.js';
import { ResearchBatchSchema } from '../research/contracts.js';
import {
  AsyncControlStore,
  effectiveResearchMode,
  type ResearchMode,
} from '../research/control.js';
import { AdviceStore } from '../knowledge/advice-store.js';
import { AdviceValidator } from '../knowledge/advice-validator.js';
import { ResearchQueue } from '../research/queue.js';
import { LlmResearchProvider } from '../research/llm-provider.js';
import {
  preparePairedEvaluation,
  runPairedEvaluation,
  type PairedPlan,
} from '../evaluation/async-research.js';
import { JevProvider } from '../policies/jev.js';
import { LedgerMeter } from '../storage/provider-meter.js';
import { Store } from '../storage/store.js';

function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}
async function main(): Promise<void> {
  const args = argumentsFor({
    op: { type: 'string', default: 'status' },
    output: { type: 'string' },
    batch: { type: 'string' },
    cutoff: { type: 'string' },
    proposal: { type: 'string' },
    publication: { type: 'string' },
    actor: { type: 'string' },
    note: { type: 'string' },
    scenarios: { type: 'string' },
    revision: { type: 'string' },
    'ttl-ms': { type: 'string', default: '86400000' },
    mode: { type: 'string' },
    'confirm-live': { type: 'boolean', default: false },
    'allow-paid': { type: 'boolean', default: false },
    run: { type: 'string' },
    limit: { type: 'string', default: '30' },
    partition: { type: 'string', default: 'holdout' },
    plan: { type: 'string' },
  });
  const required = (name: string): string => {
    const value = args[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
    return value;
  };
  const config = loadConfig();
  const options = config.asyncLlm;
  const output = resolve(
    typeof args.output === 'string'
      ? args.output
      : join('data', 'research', `${String(args.op)}-${randomUUID()}`),
  );
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (args.op === 'prepare') {
    const builder = new EvidenceBuilder(config.databasePath);
    try {
      const batches = builder.batches(typeof args.cutoff === 'string' ? args.cutoff : undefined);
      if (!batches.length) throw new Error('No verified completed live hands available');
      for (const batch of batches) writePrivate(join(output, `${batch.batchId}.json`), batch);
      writePrivate(join(output, 'manifest.json'), {
        preparedAt: new Date().toISOString(),
        batches: batches.map((b) => ({
          id: b.batchId,
          type: b.taskType,
          scope: b.scopeKey,
          hash: b.sourceSnapshotHash,
          hands: b.eligibleHandIds.length,
        })),
        paidCalls: 0,
      });
      emit({ directory: output, batches: batches.length, paidCalls: 0 });
    } finally {
      builder.close();
    }
    return;
  }
  if (args.op === 'pair-prepare') {
    const partition = required('partition');
    if (!['development', 'holdout'].includes(partition))
      throw new Error('--partition must be development or holdout');
    const plan = preparePairedEvaluation({
      rawPath: config.databasePath,
      researchPath: options.databasePath,
      runId: required('run'),
      model: config.jevModel,
      limit: numberArg(args.limit, 30, 'limit'),
      partition: partition as 'development' | 'holdout',
    });
    writePrivate(join(output, 'plan.json'), plan);
    emit({
      path: join(output, 'plan.json'),
      pairs: plan.samples.length,
      matchingAdvice: plan.samples.filter((s) => s.adviceMatched).length,
      paidCalls: 0,
      experiment: plan.experiment,
    });
    return;
  }
  if (args.op === 'pair-run') {
    if (args['allow-paid'] !== true) throw new Error('Real Jev comparison requires --allow-paid');
    const plan = JSON.parse(readFileSync(required('plan'), 'utf8')) as PairedPlan;
    if (plan.requestedModel !== config.jevModel)
      throw new Error('Configured Jev model differs from prepared plan');
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const ledger = new Store(join(output, 'evaluation.sqlite'), config.jevModel);
    try {
      const meter = new LedgerMeter(ledger, `research-evaluation-${plan.planId}`);
      const policy = new JevProvider({
        apiKey: config.jevApiKey,
        baseUrl: config.jevBaseUrl,
        model: config.jevModel,
        timeoutMs: config.jevTimeoutMs,
        meter,
      });
      const result = await runPairedEvaluation(plan, policy, config.jevDecisionTimeoutMs);
      writePrivate(join(output, 'result.json'), result);
      emit({
        path: join(output, 'result.json'),
        logicalDecisions: result.logicalDecisions,
        providerCalls: result.providerCalls,
        failedDecisions: result.failedDecisions,
        changedChoices: result.changedChoices,
        latency: result.latency,
      });
    } finally {
      ledger.close();
    }
    return;
  }
  if (args.op === 'mode') {
    const mode = required('mode');
    if (!['off', 'shadow', 'live'].includes(mode))
      throw new Error('--mode must be off, shadow or live');
    const controls = new AsyncControlStore(options.databasePath);
    try {
      const control = controls.setMode(mode as ResearchMode, {
        actor: required('actor'),
        note: required('note'),
        confirmLive: args['confirm-live'] === true,
      });
      emit({
        mode: control.mode,
        effectiveMode: effectiveResearchMode(options.mode, control),
        configuredMode: options.mode,
        changedAt: control.changedAt,
        note: 'Applies to subsequently admitted hands; existing pins and runtime stop markers are preserved.',
      });
    } finally {
      controls.close();
    }
    return;
  }
  const advice = new AdviceStore(options.databasePath);
  try {
    if (args.op === 'status') {
      emit({
        proposals: advice.listProposals().map((p) => ({
          id: p.proposalId,
          kind: p.proposal.kind,
          status: p.status,
          receivedAt: p.receivedAt,
          requiredScenarios: p.proposal.requiredScenarios,
        })),
        publications: advice.listPublications().map((p) => ({
          id: p.publicationId,
          proposalId: p.proposalId,
          revision: p.adviceRevision,
          topicKey: p.topicKey,
          expiresAt: p.expiresAt,
        })),
        audit: advice.listAudit(20),
      });
    } else if (args.op === 'inspect') {
      const proposal = advice.getProposal(required('proposal'));
      if (!proposal) throw new Error('Proposal not found');
      writePrivate(join(output, 'proposal.json'), proposal);
      emit({ path: join(output, 'proposal.json') });
    } else if (args.op === 'approve') {
      const review = advice.approve(required('proposal'), {
        actor: required('actor'),
        note: required('note'),
        passedScenarios: required('scenarios')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      emit({ id: review.proposalId, status: review.status });
    } else if (args.op === 'publish') {
      required('revision');
      emit(
        advice.publish(required('proposal'), {
          expectedRevision: numberArg(args.revision, 0, 'revision'),
          ttlMs: numberArg(args['ttl-ms'], 86400000, 'ttl-ms'),
          actor: required('actor'),
        }),
      );
    } else if (args.op === 'reject') {
      const result = advice.reject(required('proposal'), {
        actor: required('actor'),
        note: required('note'),
      });
      emit({ id: result.proposalId, status: result.status });
    } else if (args.op === 'withdraw') {
      advice.withdraw(required('publication'), {
        actor: required('actor'),
        note: required('note'),
      });
      emit({ withdrawn: args.publication });
    } else if (args.op === 'approve-recipe') {
      advice.approveRecipe({ actor: required('actor'), note: required('note') });
      emit({ approvedRecipe: 'opponent-evidence-v1' });
    } else if (args.op === 'diagnose') {
      if (args['allow-paid'] !== true)
        throw new Error('Real research diagnostic requires --allow-paid');
      if (!options.apiKey) throw new Error('LLM_RESEARCH_API_KEY is required');
      const batch = ResearchBatchSchema.parse(JSON.parse(readFileSync(required('batch'), 'utf8')));
      new AdviceValidator().validateBatch(batch);
      if (Date.parse(batch.cutoff) > Date.now())
        throw new Error('Research batch cutoff is in the future');
      const queue = new ResearchQueue(options.databasePath);
      try {
        const id = queue.enqueue(batch, `${options.provider}:${options.model}`, options.maxPending);
        if (!id) throw new Error('Batch already scheduled or queue full; no diagnostic call made');
        const job = queue.claim(`diagnose-${randomUUID()}`, options.jobTimeoutMs, Date.now(), id);
        if (!job) throw new Error('Research worker is busy; specified batch remains queued');
        const controller = new AbortController();
        const heartbeat = setInterval(() => {
          try {
            if (!queue.heartbeat(job)) controller.abort();
          } catch {
            controller.abort();
          }
        }, 3000);
        try {
          const provider = new LlmResearchProvider(options, queue.meter(job, options));
          const result = await provider.propose(
            batch,
            AbortSignal.any([controller.signal, AbortSignal.timeout(options.jobTimeoutMs)]),
          );
          if (!queue.finish(job, 'completed', result))
            throw new Error('Diagnostic lease expired; result cannot be published');
          const record = result.insufficient
            ? null
            : advice.ingest(batch, result.raw, result.model);
          queue.delivered(job.id);
          writePrivate(join(output, 'diagnostic.json'), {
            batch,
            result,
            proposalId: record?.proposalId ?? null,
          });
          emit({
            path: join(output, 'diagnostic.json'),
            proposalId: record?.proposalId ?? null,
            insufficientEvidence: result.insufficient,
            attempts: result.attempts.length,
            model: result.model,
            status: queue.status(),
          });
        } catch {
          queue.finish(job, 'failed', { code: 'diagnostic_failed' }, 'diagnostic_failed');
          throw new Error(
            `Research diagnostic failed; inspect private job ${job.id} and its attempt ledger.`,
          );
        } finally {
          clearInterval(heartbeat);
        }
      } finally {
        queue.close();
      }
    } else
      throw new Error(
        'Unknown --op. Use prepare, diagnose, status, inspect, approve, publish, reject, withdraw, approve-recipe, mode, pair-prepare or pair-run.',
      );
  } finally {
    advice.close();
  }
}
void main().catch(fail);
