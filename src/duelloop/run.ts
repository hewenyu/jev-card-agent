import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DuelLoop,
  DuelLoopError,
  SqliteStore,
  digest,
  type DecisionModel,
  type DecisionRecord,
} from 'duelloop';
import {
  createPokerReplayDomain,
  POKER_REPLAY_APPLICATION_ID,
  POKER_REPLAY_SCOPE_ID,
  replayInput,
} from './domain.js';
import { createPokerReplayStrategy } from './strategy.js';
import { AuditedDecisionModel } from './model.js';
import { appendLedger } from './ledger.js';
import { validateReplayPlan, type ReplayPlan } from './plan.js';
import { replayResult, summarizeReplay, type ReplayResult } from './report.js';

/** Artifacts contain private frozen state; refuse to overwrite another experiment. */
export function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export async function runReplayPlan(options: {
  plan: ReplayPlan;
  model: DecisionModel;
  outputDirectory: string;
  decisionTimeoutMs?: number;
  signal?: AbortSignal;
}) {
  const plan = validateReplayPlan(options.plan);
  const timeoutMs = options.decisionTimeoutMs ?? 40000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw new Error('Replay decision timeout must be 100..120000 milliseconds');
  options.signal?.throwIfAborted();
  mkdirSync(dirname(options.outputDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(options.outputDirectory, { mode: 0o700 });
  writePrivateJson(join(options.outputDirectory, 'plan.json'), plan);
  const store = new SqliteStore(join(options.outputDirectory, 'duelloop.sqlite'));
  chmodSync(join(options.outputDirectory, 'duelloop.sqlite'), 0o600);
  const attemptFile = join(options.outputDirectory, 'attempts.jsonl');
  let currentSourceId: string | null = null;
  let currentDeadline = 0;
  const sources = new Map<string, string | null>();
  const model = new AuditedDecisionModel(
    options.model,
    (attempt) => {
      // The file remains available even if the SDK deadline wins before a cancelled
      // HTTP promise settles. A late result is audited, never used as an action.
      appendLedger(attemptFile, { originalDecisionId: sources.get(attempt.requestId), ...attempt });
    },
    {
      deadlineAt: () => currentDeadline,
      onStart(start) {
        sources.set(start.requestId, currentSourceId);
        appendLedger(join(options.outputDirectory, 'requests.jsonl'), {
          originalDecisionId: currentSourceId,
          ...start,
        });
      },
      onLateResult(result) {
        appendLedger(join(options.outputDirectory, 'late-results.jsonl'), {
          originalDecisionId: sources.get(result.requestId),
          ...result,
        });
      },
    },
  );
  const app = new DuelLoop({
    applicationId: POKER_REPLAY_APPLICATION_ID,
    domain: createPokerReplayDomain(),
    model,
    store,
    mode: 'shadow',
    executionOwner: 'host',
    maxDecisionMs: timeoutMs,
    executionReserveMs: 25,
  });
  const cancel = () => {
    void app.stop({ drain: false, timeoutMs: 1000 }).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const strategy = createPokerReplayStrategy();
    const releaseDigest = app.bootstrap(strategy, POKER_REPLAY_SCOPE_ID);
    store.putArtifact('source_plan', plan, 'private');
    const rows: ReplayResult[] = [];
    let stopped = false;
    for (const sample of plan.samples) {
      const base: ReplayResult = {
        originalDecisionId: sample.decisionId,
        originalChoice: sample.originalChoice,
        selected: null,
        matchesOriginal: null,
        tiedBestActions: [],
        code: null,
        elapsedMs: 0,
        decision: null,
        status: 'not_run',
      };
      if (stopped || options.signal?.aborted) {
        rows.push(base);
        continue;
      }
      currentSourceId = sample.decisionId;
      const started = performance.now();
      try {
        const { observation, candidates } = replayInput(sample, timeoutMs);
        // Mirror the SDK's execution reserve and retain a wall-clock guard even
        // when a synchronous ledger flush delays the signal's timer callback.
        currentDeadline = observation.deadline - 25;
        const decision = await app.decide(observation, candidates);
        rows.push(replayResult(sample, decision, performance.now() - started));
      } catch (error) {
        const code = error instanceof DuelLoopError ? error.code : 'REPLAY_FAILED';
        const event = store.latestEvent(POKER_REPLAY_SCOPE_ID, 'decision');
        const failed = event?.data as unknown as DecisionRecord | undefined;
        rows.push({
          ...base,
          status: 'failed',
          code,
          elapsedMs: performance.now() - started,
          decision:
            failed?.observation.revision === sample.inputHash && failed.decisionSource === 'stopped'
              ? failed
              : null,
        });
        stopped = true;
      }
    }
    // No live rewards are assigned to counterfactual shadow decisions. A separate
    // historical trajectory namespace prevents accidental decision/reward joins.
    for (const outcome of plan.historicalOutcomes) {
      await app.submitFeedback({
        feedbackId: `historical:${plan.sourceRunId}:${outcome.handId}`,
        revision: 1,
        applicationId: POKER_REPLAY_APPLICATION_ID,
        strategyScopeId: POKER_REPLAY_SCOPE_ID,
        trajectoryId: `historical:${plan.sourceRunId}:${outcome.handId}`,
        eventTime: Date.parse(outcome.completedAt),
        receivedAt: Date.now(),
        settled: true,
        metrics: { historicalActualTrajectoryNetChips: outcome.netChips },
      });
    }
    const snapshotId = store.snapshot(POKER_REPLAY_SCOPE_ID, Date.now(), {
      maxDecisions: 1000,
      maxFeedback: 1000,
    });
    const summary = summarizeReplay(plan, rows, model.attempts);
    const report = {
      completedAt: new Date().toISOString(),
      framework: {
        package: 'duelloop',
        version: '0.2.2',
        commit: '422e24832919a3d72a2936272365e4c827178ec2',
        mode: 'shadow',
        executionOwner: 'host',
        releaseDigest,
        strategyDigest: digest(strategy),
        snapshotId,
        dependencies: app.dependencies,
      },
      summary,
      rows,
      historicalOutcomes: plan.historicalOutcomes,
    };
    writePrivateJson(join(options.outputDirectory, 'report.json'), report);
    writePrivateJson(join(options.outputDirectory, 'summary.json'), summary);
    return report;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await app.close();
    store.close();
  }
}
