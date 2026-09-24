import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuelLoopError, FixtureDecisionModel, type DecisionRecord } from 'duelloop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Proposal } from '../src/core/types.js';
import { createInitialState } from '../src/core/state.js';
import { LiveDecisionCoordinator } from '../src/duelloop/live/coordinator.js';
import { LiveUsageLedger } from '../src/duelloop/live/usage.js';
import { AuditedDecisionModel } from '../src/duelloop/model.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { PokerRuntime } from '../src/runtime/runtime.js';
import { Store } from '../src/storage/store.js';
import { arena, joined, resync, send, turn } from './helpers/runtime-arena.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

function innerModel() {
  return new FixtureDecisionModel('reconnect-score-fixture', (question) => {
    const score = question.actionId === 'check' ? question.criteria.length - 1 : 0;
    return {
      score,
      confidence: 0.9,
      probabilities: Object.fromEntries(
        question.criteria.map((_, index) => [index, index === score ? 1 : 0]),
      ),
    };
  });
}

function createLive(urls: { wsUrl: string; restUrl: string }, inner: FixtureDecisionModel) {
  const directory = mkdtempSync(join(tmpdir(), 'duelloop-cancel-reconnect-'));
  const raw = new Store(join(directory, 'raw.sqlite'));
  raw.acquireLease();
  const ledger = new LiveUsageLedger(raw, 'reconnect-run', inner.id);
  const model = new AuditedDecisionModel(inner, ledger.finish, {
    onStart: ledger.start,
    onLateResult: ledger.late,
    maxRetries: 3,
  });
  const holder: { runtime?: PokerRuntime } = {};
  const coordinator = new LiveDecisionCoordinator({
    raw,
    model,
    databasePath: join(directory, 'sdk.sqlite'),
    scopeId: 'reconnect-scope',
    actorId: 'hero',
    facts: baselineSnapshot,
    mode: 'simulation',
    state: () => holder.runtime?.state ?? createInitialState(),
  });
  const runtime = new PokerRuntime({
    ...urls,
    apiKey: 'test-secret',
    engine: coordinator,
    store: coordinator.bridge.store,
  });
  holder.runtime = runtime;
  const active = runtime;
  disposals.push(async () => {
    active.stop(false);
    await vi.waitFor(() => expect(['stopped', 'idle', 'failed']).toContain(active.status().phase), {
      timeout: 4000,
    });
    await active.settleDecisions();
    await coordinator.close();
    raw.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime: active, raw, coordinator, model };
}

function decisions(coordinator: LiveDecisionCoordinator): DecisionRecord[] {
  return coordinator.sdk
    .events({ types: ['decision'] })
    .map((event) => event.data as unknown as DecisionRecord);
}

function proposal(raw: Store, id: string): Proposal {
  const row = raw.db.prepare('SELECT proposal FROM decisions WHERE id=?').get(id)!;
  return JSON.parse(String(row.proposal)) as Proposal;
}

describe('Score interrupted by a WebSocket disconnect in the same authorized turn', () => {
  it('reauthorizes Score without extending its deadline or mixing usage, and never executes the late result', async () => {
    let socket: WebSocket | undefined;
    let connections = 0;
    const urls = await arena((ws, message, connection) => {
      socket = ws;
      connections = Math.max(connections, connection);
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'resync_request') resync(ws, 'h1', 'token-1');
      if (message.type === 'action')
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = innerModel();
    const original = inner.score.bind(inner);
    let count = 0;
    const score = vi.spyOn(inner, 'score').mockImplementation(async (request) => {
      const call = ++count;
      // Construct the answer while authority is valid, then simulate a transport that ignores abort.
      const response = await original(request);
      if (call === 1) {
        socket!.terminate();
        await blocked;
      }
      return {
        ...response,
        usage: { inputTokens: call * 100, outputTokens: call * 10, costUsd: 0, unknown: false },
      };
    });
    const f = createLive(urls, inner);
    const actions = () => urls.messages.filter((message) => message.type === 'action');
    try {
      await f.runtime.start({
        runId: 'reconnect-run',
        strategy: 'jev',
        reconnectMinMs: 1,
        reconnectMaxMs: 2,
      });
      await vi.waitFor(
        () =>
          expect(
            actions(),
            JSON.stringify({ status: f.runtime.status(), block: f.raw.loadDecisionBlock() }),
          ).toHaveLength(1),
        { timeout: 5000 },
      );
      await f.runtime.settleDecisions();
      expect(connections).toBe(2);
      expect(score).toHaveBeenCalledTimes(2);
      const records = decisions(f.coordinator);
      expect(records).toHaveLength(2);
      const cancelled = records.find((record) => record.stopReason === 'CANCELLED')!;
      const accepted = records.find((record) => record.decisionSource === 'strategy')!;
      expect(cancelled).toBeTruthy();
      expect(accepted).toBeTruthy();
      expect(accepted.decisionId).not.toBe(cancelled.decisionId);
      expect(accepted.observation.revision).toBe(cancelled.observation.revision);
      expect(accepted.observation.deadline).toBe(cancelled.observation.deadline);
      expect(accepted.modelDeadline).toBe(cancelled.modelDeadline);
      expect(cancelled.modelDeadline).toBeLessThan(cancelled.observation.deadline);
      expect(actions()[0]?.client_action_id).toBe(accepted.decisionId);
      expect(f.coordinator.sdk.intent(cancelled.decisionId)).toBeUndefined();
      expect(f.coordinator.sdk.intents()).toHaveLength(1);
      expect(f.raw.loadDecisionBlock()).toBeNull();
      expect(f.coordinator.runtime.status().failure).toBeUndefined();

      const oldProposal = proposal(f.raw, cancelled.decisionId);
      const nextProposal = proposal(f.raw, accepted.decisionId);
      expect(oldProposal.attempts).toHaveLength(1);
      expect(nextProposal.attempts).toHaveLength(1);
      const oldId = oldProposal.attempts![0]!.id;
      const nextId = nextProposal.attempts![0]!.id;
      expect(oldId).not.toBe(nextId);
      expect(oldProposal.attempts![0]!.status).toBe('cancelled');
      expect(nextProposal.attempts![0]!.status).toBe('succeeded');
      expect(nextProposal.request).toEqual(oldProposal.request);
      expect(nextProposal.attempts![0]!.usage?.input_tokens).toBe(200);
      const oldUsage = () =>
        f.raw.db
          .prepare(
            'SELECT u.* FROM usage u JOIN framework_calls c ON c.reservation_id=u.id WHERE c.request_id=?',
          )
          .get(oldId)!;
      expect(oldUsage().status).toBe('unknown');

      release();
      await vi.waitFor(() => expect(oldUsage().status).toBe('settled'));
      expect(oldUsage().input_tokens).toBe(100);
      expect(oldUsage().charged_nanos).toBeGreaterThan(0);
      const late = f.raw.db
        .prepare('SELECT result,late_result FROM framework_calls WHERE request_id=?')
        .get(oldId)!;
      expect(JSON.parse(String(late.result)).code).toBe('CANCELLED');
      expect(JSON.parse(String(late.late_result)).usage.inputTokens).toBe(100);
      expect(f.raw.db.prepare('SELECT COUNT(*) AS n FROM usage').get()?.n).toBe(2);
      expect(score).toHaveBeenCalledTimes(2);
      expect(actions()).toHaveLength(1);
      expect(f.coordinator.sdk.intent(cancelled.decisionId)).toBeUndefined();

      // Simulate replaying the durable SDK projection after process memory is gone.
      f.raw.db.prepare('DELETE FROM framework_cursors').run();
      f.coordinator.recoverProjections();
      expect(proposal(f.raw, cancelled.decisionId).attempts?.map((attempt) => attempt.id)).toEqual([
        oldId,
      ]);
      expect(proposal(f.raw, accepted.decisionId).attempts?.map((attempt) => attempt.id)).toEqual([
        nextId,
      ]);
      expect(f.raw.loadDecisionBlock()).toBeNull();
      expect(f.coordinator.runtime.status().failure).toBeUndefined();
    } finally {
      release();
    }
  });

  it('still stops durably when real model failures exhaust the initial request and three retries', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const inner = innerModel();
    const score = vi
      .spyOn(inner, 'score')
      .mockRejectedValue(new DuelLoopError('MODEL_INVALID', 'bad score'));
    const f = createLive(urls, inner);
    await f.runtime.start({ runId: 'reconnect-run', strategy: 'jev' });
    await vi.waitFor(() => expect(f.raw.loadDecisionBlock()?.reason).toBe('MODEL_INVALID'));
    expect(score).toHaveBeenCalledTimes(4);
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    expect(f.coordinator.sdk.intents()).toHaveLength(0);
    expect(f.coordinator.runtime.status().failure?.code).toBe('MODEL_INVALID');
    const record = decisions(f.coordinator)[0]!;
    expect(record.stopReason).toBe('MODEL_INVALID');
    expect(proposal(f.raw, record.decisionId).attempts).toHaveLength(4);
    expect(f.raw.db.prepare('SELECT COUNT(*) AS n FROM usage').get()?.n).toBe(4);
  });
});
