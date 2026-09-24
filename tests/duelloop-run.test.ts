import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DuelLoopError,
  FixtureDecisionModel,
  SqliteStore,
  digest,
  type DecisionModel,
  type DecisionRecord,
} from 'duelloop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POKER_REPLAY_SCOPE_ID } from '../src/duelloop/domain.js';
import { validateReplayPlan, type ReplayPlan, type ReplaySample } from '../src/duelloop/plan.js';
import { runReplayPlan } from '../src/duelloop/run.js';

function frozenPlan(): ReplayPlan {
  const samples: ReplaySample[] = ['preflop', 'flop', 'river'].map((street, index) => {
    const request = {
      model: 'jev-1.13.0',
      state: {
        street,
        holeCards: ['Ah', 'Kd'],
        board: ['2c', '7d', 'Ts', 'Jc', '3h'].slice(0, [0, 3, 5][index]),
        heroSeat: 0,
        dealerSeat: 1,
        bigBlind: 20,
        historyIncomplete: false,
        seats: [
          { seat: 0, stack: 900, bet: 20 },
          { seat: 1, stack: 880, bet: 40 },
        ],
        approvedAdvice:
          index === 2
            ? [{ summary: 'Archived opponent evidence, not a fresh research result.' }]
            : [],
      },
      questions: {
        action: {
          type: 'choice' as const,
          instructions: {
            task: 'Use visible facts to choose a legal action for long-run chip expectation.',
          },
          criteria: {
            fold: { action: 'fold', additionalChips: 0 },
            call: { action: 'call', additionalChips: 20 },
          },
        },
      },
    };
    return {
      decisionId: `decision-${index}`,
      runId: 'source-run',
      handId: index < 2 ? 'hand-a' : 'hand-b',
      tableId: 'source-table',
      street: street as ReplaySample['street'],
      originalAt: `2026-01-01T00:0${index + 1}:00.000Z`,
      originalChoice: 'fold',
      originalModel: request.model,
      originalLatencyMs: 300 + index,
      inputHash: digest(request),
      request,
      candidates: [
        { id: 'fold', action: 'fold', label: 'Fold' },
        { id: 'call', action: 'call', label: 'Call 20' },
      ],
    };
  });
  const content = {
    schemaVersion: 'duelloop-poker-shadow-v1' as const,
    preparedAt: '2026-01-02T00:00:00.000Z',
    sourceRunId: 'source-run',
    sourceMode: 'live' as const,
    selection: 'street_round_robin_then_chronological' as const,
    scanned: 3,
    scanLimitReached: false,
    excluded: {},
    samples,
    historicalOutcomes: [
      { handId: 'hand-a', completedAt: '2026-01-01T00:02:30.000Z', netChips: -40, bigBlind: 20 },
      { handId: 'hand-b', completedAt: '2026-01-01T00:04:00.000Z', netChips: 80, bigBlind: 20 },
    ],
  };
  return validateReplayPlan({ ...content, planHash: digest(content) });
}

function fixtureModel() {
  return new FixtureDecisionModel('run-test-fixture', (question) => {
    const score = question.actionId === 'call' ? 4 : 1;
    return {
      score,
      confidence: 1,
      probabilities: Object.fromEntries(
        Array.from({ length: 5 }, (_, level) => [String(level), level === score ? 1 : 0]),
      ),
    };
  });
}

describe('DuelLoop frozen replay runner', () => {
  let directory: string;
  let outputDirectory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'duelloop-run-'));
    outputDirectory = join(directory, 'experiment');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  function attempts() {
    return readFileSync(join(outputDirectory, 'attempts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it('persists actual SDK decisions, release bindings and historical-only feedback after all model calls', async () => {
    const plan = frozenPlan();
    const before = structuredClone(plan);
    const model = fixtureModel();
    const score = vi.spyOn(model, 'score');
    const report = await runReplayPlan({ plan, model, outputDirectory });

    expect(plan).toEqual(before);
    expect(score).toHaveBeenCalledTimes(3);
    expect(report.summary).toMatchObject({
      planned: 3,
      succeeded: 3,
      failed: 0,
      notRun: 0,
      legalSelections: 3,
      originalChoiceMatches: 0,
      modelCalls: 3,
      retries: 0,
      questions: 6,
      modelKinds: ['fixture'],
      actualModels: ['run-test-fixture'],
      archivedAdviceSamples: 1,
    });
    expect(report.framework.dependencies.modelKind).toBe('fixture');
    expect(report.rows.every((row) => row.selected === 'call')).toBe(true);
    expect(json(join(outputDirectory, 'plan.json'))).toEqual(before);
    expect(json(join(outputDirectory, 'report.json'))).toEqual(report);
    expect(json(join(outputDirectory, 'summary.json'))).toEqual(report.summary);
    expect(statSync(join(outputDirectory, 'plan.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(outputDirectory, 'duelloop.sqlite')).mode & 0o777).toBe(0o600);
    expect(attempts().map((attempt) => attempt.originalDecisionId)).toEqual(
      plan.samples.map((sample) => sample.decisionId),
    );

    const store = new SqliteStore(join(outputDirectory, 'duelloop.sqlite'));
    try {
      expect(store.listArtifacts('strategy')).toHaveLength(1);
      expect(store.activeRelease(POKER_REPLAY_SCOPE_ID)).toBe(report.framework.releaseDigest);
      expect(store.listArtifacts('source_plan', true)).toHaveLength(1);
      const decisions = store
        .listArtifacts('decision')
        .map((artifact) => artifact.value as unknown as DecisionRecord);
      expect(decisions).toHaveLength(3);
      expect(
        decisions.every((decision) => decision.releaseDigest === report.framework.releaseDigest),
      ).toBe(true);
      const feedback = store.latestFeedback(POKER_REPLAY_SCOPE_ID).map((entry) => entry.feedback);
      expect(feedback).toHaveLength(2);
      expect(feedback.map((event) => event.metrics)).toEqual([
        { historicalActualTrajectoryNetChips: -40 },
        { historicalActualTrajectoryNetChips: 80 },
      ]);
      for (const event of feedback) {
        expect(event.trajectoryId).toMatch(/^historical:/);
        expect(event.decisionId).toBeUndefined();
        expect(
          decisions.some((decision) => decision.observation.trajectoryId === event.trajectoryId),
        ).toBe(false);
      }
      const events = store.events({
        scopeId: POKER_REPLAY_SCOPE_ID,
        types: ['decision', 'feedback.received'],
      });
      expect(events.map((event) => event.type)).toEqual([
        'decision',
        'decision',
        'decision',
        'feedback.received',
        'feedback.received',
      ]);
      expect(store.intents()).toEqual([]);
      expect(
        store.getArtifact<{ decisions: unknown[]; feedback: unknown[] }>(
          report.framework.snapshotId,
        ),
      ).toMatchObject({ decisions: expect.any(Array), feedback: expect.any(Array) });
    } finally {
      store.close();
    }
    for (const [request] of score.mock.calls) {
      const wire = JSON.stringify(request.state);
      expect(wire).not.toContain('historicalActualTrajectoryNetChips');
      expect(wire).not.toContain('historicalOutcomes');
      expect(wire).not.toContain('originalChoice');
    }
  });

  it('retains a failed decision and retry ledger, stops remaining samples and writes its report', async () => {
    const model = fixtureModel();
    const original = model.score.bind(model);
    let calls = 0;
    vi.spyOn(model, 'score').mockImplementation((request) => {
      calls++;
      if (calls > 1) throw new DuelLoopError('MODEL_INVALID', 'Fixture unavailable');
      return original(request);
    });
    const report = await runReplayPlan({ plan: frozenPlan(), model, outputDirectory });

    expect(report.rows.map((row) => row.status)).toEqual(['succeeded', 'failed', 'not_run']);
    expect(report.summary).toMatchObject({
      succeeded: 1,
      failed: 1,
      notRun: 1,
      modelCalls: 5,
      retries: 3,
    });
    expect(report.rows[1]?.decision).toMatchObject({
      action: null,
      decisionSource: 'stopped',
      stopReason: 'MODEL_INVALID',
    });
    expect(report.rows[1]?.selected).toBeNull();
    expect(report.rows[2]?.decision).toBeNull();
    expect(attempts().map((attempt) => [attempt.originalDecisionId, attempt.retryIndex])).toEqual([
      ['decision-0', 0],
      ['decision-1', 0],
      ['decision-1', 1],
      ['decision-1', 2],
      ['decision-1', 3],
    ]);
    expect(json(join(outputDirectory, 'report.json'))).toEqual(report);
    const store = new SqliteStore(join(outputDirectory, 'duelloop.sqlite'));
    try {
      expect(store.listArtifacts('decision')).toHaveLength(2);
      expect(store.intents()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('refuses an existing output directory without touching its files or calling a model', async () => {
    mkdirSync(outputDirectory);
    const marker = join(outputDirectory, 'existing-experiment');
    writeFileSync(marker, 'preserve-me');
    const model = fixtureModel();
    const score = vi.spyOn(model, 'score');
    await expect(runReplayPlan({ plan: frozenPlan(), model, outputDirectory })).rejects.toThrow(
      'EEXIST',
    );
    expect(readFileSync(marker, 'utf8')).toBe('preserve-me');
    expect(existsSync(join(outputDirectory, 'plan.json'))).toBe(false);
    expect(score).not.toHaveBeenCalled();
  });

  it('preserves token-only and partially billed SDK usage through the final report', async () => {
    const model: DecisionModel = fixtureModel();
    const original = model.score.bind(model);
    let calls = 0;
    vi.spyOn(model, 'score').mockImplementation(async (request) => ({
      ...(await original(request)),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        unknown: false,
        ...(calls++ === 0 ? {} : { knownCostUsd: 0.2, costUnknown: true }),
      },
    }));
    const report = await runReplayPlan({ plan: frozenPlan(), model, outputDirectory });
    expect(report.summary.knownUsage).toEqual({ inputTokens: 30, outputTokens: 15 });
    expect(report.summary.unknownUsageCalls).toBe(0);
    expect(report.summary.dollarCost).toEqual({
      knownCostUsd: 0.4,
      costUnknown: true,
      totalCostUsd: null,
      unknownCostCalls: 3,
    });
    expect(report.rows.every((row) => row.decision?.usage?.costUnknown === true)).toBe(true);
    expect(attempts().every((attempt) => !Object.hasOwn(attempt.usage, 'costUsd'))).toBe(true);
  });

  it('rejects an invalid plan before creating even its parent directory or calling a model', async () => {
    const plan = frozenPlan();
    plan.samples[0]!.originalChoice = 'call';
    const model = fixtureModel();
    const score = vi.spyOn(model, 'score');
    const nested = join(directory, 'not-created', 'experiment');
    await expect(runReplayPlan({ plan, model, outputDirectory: nested })).rejects.toThrow(
      'integrity',
    );
    expect(existsSync(join(directory, 'not-created'))).toBe(false);
    expect(score).not.toHaveBeenCalled();
  });

  it('honors cancellation before initialization without creating an experiment', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = fixtureModel();
    const score = vi.spyOn(model, 'score');
    await expect(
      runReplayPlan({ plan: frozenPlan(), model, outputDirectory, signal: controller.signal }),
    ).rejects.toThrow();
    expect(existsSync(outputDirectory)).toBe(false);
    expect(score).not.toHaveBeenCalled();
  });

  it('records in-flight cancellation without retrying or inventing a selected action', async () => {
    const controller = new AbortController();
    const model = fixtureModel();
    const score = vi
      .spyOn(model, 'score')
      .mockImplementation(async (request: Parameters<DecisionModel['score']>[0]) => {
        controller.abort();
        request.signal.throwIfAborted();
        throw new Error('Cancellation should abort the provider signal');
      });
    const report = await runReplayPlan({
      plan: frozenPlan(),
      model,
      outputDirectory,
      signal: controller.signal,
    });
    expect(score).toHaveBeenCalledTimes(1);
    expect(report.rows.map((row) => row.status)).toEqual(['failed', 'not_run', 'not_run']);
    expect(report.rows[0]?.decision?.action).toBeNull();
    expect(report.summary.modelCalls).toBe(1);
    expect(attempts()).toEqual([
      expect.objectContaining({
        status: 'failed',
        code: 'CANCELLED',
        retryIndex: 0,
        originalDecisionId: 'decision-0',
      }),
    ]);
  });
});
