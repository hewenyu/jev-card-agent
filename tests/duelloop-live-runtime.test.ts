import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuelLoopError, FixtureDecisionModel, type DecisionModel } from 'duelloop';
import type { WebSocket } from 'ws';
import { LiveDecisionCoordinator } from '../src/duelloop/live/coordinator.js';
import { PokerRuntime } from '../src/runtime/runtime.js';
import { Store } from '../src/storage/store.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { createInitialState } from '../src/core/state.js';
import { pokerState } from './helpers/duelloop-fixture.js';
import { authorityKey, decisionStateKey } from '../src/runtime/authority.js';
import type { DecisionTask } from '../src/runtime/engine.js';
import { arena, joined, resync, send, turn } from './helpers/runtime-arena.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

function scoreModel(selected = 'check') {
  return new FixtureDecisionModel('websocket-score-fixture', (question) => {
    const score = question.actionId === selected ? question.criteria.length - 1 : 0;
    return {
      score,
      confidence: 0.8,
      probabilities: Object.fromEntries(
        question.criteria.map((_, index) => [index, index === score ? 1 : 0]),
      ),
    };
  });
}
function createLive(
  urls: { wsUrl: string; restUrl: string },
  model: DecisionModel = scoreModel(),
  storageDirectory?: string,
) {
  const directory = storageDirectory ?? mkdtempSync(join(tmpdir(), 'duelloop-ws-')),
    raw = new Store(join(directory, 'raw.sqlite'));
  raw.acquireLease();
  const holder: { runtime?: PokerRuntime } = {};
  const coordinator = new LiveDecisionCoordinator({
    raw,
    model,
    databasePath: join(directory, 'sdk.sqlite'),
    scopeId: 'websocket-scope',
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
function raiseTurn(ws: WebSocket, hand: number) {
  send(ws, {
    type: 'hand_start',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: hand * 100,
    seat: 0,
    blinds: { small_blind: 10, big_blind: 20 },
  });
  send(ws, {
    type: 'hole_cards',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: hand * 100 + 1,
    cards: ['Ah', 'Kd'],
  });
  send(ws, {
    type: 'your_turn',
    table_id: 't1',
    hand_id: `h${hand}`,
    table_seq: hand * 100 + 4,
    turn_token: `token-${hand}`,
    pot: 40,
    valid_actions: [
      { action: 'check' },
      { action: 'fold' },
      { action: 'raise', min: 20, max: 200 },
    ],
  });
}

describe('production engine through simulated OpenPoker WebSocket', () => {
  it('retains a resync batch settlement until asynchronous hand binding finishes', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        send(ws, {
          type: 'resync_response',
          table_id: 't1',
          to_table_seq: 102,
          replayed_events: [
            {
              type: 'hand_start',
              table_id: 't1',
              hand_id: 'h1',
              table_seq: 100,
              seat: 0,
              blinds: { small_blind: 10, big_blind: 20 },
            },
            {
              type: 'hand_result',
              table_id: 't1',
              hand_id: 'h1',
              table_seq: 102,
              final_stacks: { '0': 2040, '1': 1960 },
            },
          ],
          snapshot: { table_id: 't1', hand_id: 'h1', street: 'showdown', seats: [] },
        });
      }
    });
    const f = createLive(urls);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activate = f.coordinator.runtime.activatePending.bind(f.coordinator.runtime);
    vi.spyOn(f.coordinator.runtime, 'activatePending').mockImplementationOnce(async (scope) => {
      await gate;
      return activate(scope);
    });
    try {
      await f.runtime.start({ maxHands: 1 });
      await vi.waitFor(() =>
        expect(f.raw.db.prepare('SELECT complete FROM hands WHERE id=?').get('h1')?.complete).toBe(
          1,
        ),
      );
      expect(
        f.coordinator.sdk.feedbackProgress('websocket-scope', 0, 'first_settlement')
          .settledTrajectories,
      ).toBe(0);
    } finally {
      release();
    }
    await vi.waitFor(() =>
      expect(f.raw.db.prepare('SELECT release FROM framework_hands').get()?.release).toBeTruthy(),
    );
    await f.coordinator.bridge.flush();
    await f.coordinator.bridge.flush();
    expect(
      f.coordinator.sdk.feedbackProgress('websocket-scope', 0, 'first_settlement')
        .settledTrajectories,
    ).toBe(1);
    expect(f.coordinator.sdk.events({ types: ['feedback.received'] })).toHaveLength(1);
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
  });

  it('observes asynchronous hand-binding failure before any model action is submitted', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        send(ws, { type: 'hand_start', table_id: 't1', hand_id: 'h1', table_seq: 100 });
      }
    });
    const { runtime, coordinator } = createLive(urls);
    vi.spyOn(coordinator, 'pin').mockRejectedValue(new Error('binding storage unavailable'));
    await runtime.start({ maxHands: 0 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('failed'));
    expect(runtime.status().lastError).toContain('binding storage unavailable');
    expect(urls.messages.some((message) => message.type === 'action')).toBe(false);
  });

  it.each([false, true])(
    'cold restart resumes the original intent without Score (missing host-ready=%s)',
    async (missingReady) => {
      const directory = mkdtempSync(join(tmpdir(), 'duelloop-cold-ws-'));
      const raw = new Store(join(directory, 'raw.sqlite'));
      raw.acquireLease();
      raw.beginRun({
        id: 'before-restart',
        kind: 'live',
        strategy: 'jev',
        startedAt: new Date().toISOString(),
        config: {},
      });
      const state = {
        ...pokerState(),
        tableId: 't1',
        handId: 'h1',
        turnToken: 'token-1',
        dealerSeat: null,
        street: 'preflop' as const,
        board: [],
        holeCards: ['Ah', 'Kd'],
        pot: 40,
        seats: [
          { seat: 0, name: 'hero', stack: 2000, bet: 0, status: 'active' },
          { seat: 1, name: 'other', stack: 2000, bet: 0, status: 'active' },
        ],
        validActions: [{ action: 'check' as const }, { action: 'fold' as const }],
      };
      const prior = new LiveDecisionCoordinator({
        raw,
        model: scoreModel(),
        databasePath: join(directory, 'sdk.sqlite'),
        scopeId: 'websocket-scope',
        actorId: 'hero',
        facts: baselineSnapshot,
        mode: 'simulation',
        state: () => structuredClone(state),
      });
      raw.saveCheckpoint({ tableId: state.tableId, lastTableSeq: state.lastTableSeq, state });
      const now = Date.now();
      const task: DecisionTask = {
        key: authorityKey(state),
        stateKey: decisionStateKey(state),
        state,
        controller: new AbortController(),
        receivedAt: now,
        decisionDeadlineAt: now + 20_000,
        deadlineAt: now + 30_000,
        recovered: false,
        opponents: [],
      };
      const result = await prior.decide(task, 'before-restart', 20_000);
      expect(result?.action, result?.decision.fallbackReason ?? '').toBeTruthy();
      const originalAction = result!.action!,
        originalOwner = prior.sdk.intent(originalAction.id)!.ownerToken;
      if (!missingReady) {
        prior.bridge.prepare(originalAction);
        prior.beforeSend(originalAction, state);
        raw.updateAction(originalAction.id, 'sent');
      }
      await prior.close();
      raw.close();
      let seated = true;
      const urls = await arena(
        (ws, message) => {
          if (message.type === 'resync_request') resync(ws, 'h1', 'token-1');
          if (message.type === 'action') {
            send(ws, {
              type: 'action_ack',
              client_action_id: message.client_action_id,
              status: 'accepted',
            });
            send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
          }
          if (message.type === 'leave_table') seated = false;
        },
        () => (seated ? { playing: true, table_id: 't1', seat: 0 } : { playing: false }),
      );
      const model = scoreModel(),
        score = vi.spyOn(model, 'score');
      const f = createLive(urls, model, directory);
      await f.runtime.start({ strategy: 'jev', maxHands: 1 });
      await vi.waitFor(
        () => expect(f.runtime.status().phase, f.runtime.status().lastError ?? '').toBe('stopped'),
        { timeout: 5000 },
      );
      expect(score).not.toHaveBeenCalled();
      const actions = urls.messages.filter((message) => message.type === 'action');
      expect(actions).toEqual([originalAction.payload]);
      const intent = f.coordinator.sdk.intent(originalAction.id)!;
      expect(intent.ownerToken).not.toBe(originalOwner);
      expect(intent.receipt?.status).toBe('completed');
      expect(intent.command.deadline).toBe(task.deadlineAt);
      expect(f.coordinator.sdk.intents()).toHaveLength(1);
    },
  );

  it('submits SDK decision IDs and exact raise-to amounts, completes receipts and plays the next hand', async () => {
    const submitted: Record<string, unknown>[] = [];
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        raiseTurn(ws, 1);
      }
      if (message.type === 'action') {
        submitted.push(message);
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
          table_id: 't1',
          hand_id: message.hand_id,
        });
        send(ws, {
          type: 'hand_result',
          table_id: 't1',
          hand_id: message.hand_id,
          table_seq: submitted.length * 100 + 20,
        });
        if (submitted.length === 1) raiseTurn(ws, 2);
      }
    });
    const f = createLive(urls, scoreModel('raise_to_50')),
      score = vi.spyOn(f.model, 'score');
    await f.runtime.start({ strategy: 'jev', maxHands: 2 });
    await vi.waitFor(
      () => expect(f.runtime.status().phase, f.runtime.status().lastError ?? '').toBe('stopped'),
      { timeout: 5000 },
    );
    expect(submitted).toHaveLength(2);
    expect(score).toHaveBeenCalledTimes(2);
    expect(submitted.map((action) => [action.action, action.amount])).toEqual([
      ['raise', 50],
      ['raise', 50],
    ]);
    const intents = f.coordinator.sdk.intents();
    expect(intents).toHaveLength(2);
    for (let index = 0; index < 2; index++) {
      expect(submitted[index]?.client_action_id).toBe(intents[index]?.decisionId);
      expect(intents[index]?.receipt?.status).toBe('completed');
      expect(intents[index]?.command.action.parameters.raiseToChips).toBe(submitted[index]?.amount);
    }
    expect(f.coordinator.sdk.unresolvedIntents()).toHaveLength(0);
    expect(f.raw.pendingActions()).toHaveLength(0);
  });

  it('persists a model failure and decision block without creating any fallback action', async () => {
    const urls = await arena((ws, message) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const model = scoreModel();
    const score = vi
      .spyOn(model, 'score')
      .mockRejectedValue(new DuelLoopError('MODEL_INVALID', 'fixture model failure'));
    const f = createLive(urls, model);
    await f.runtime.start({ strategy: 'jev' });
    await vi.waitFor(() => expect(f.raw.loadDecisionBlock()?.reason).toBe('MODEL_INVALID'));
    expect(score).toHaveBeenCalledTimes(1);
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(0);
    expect(f.coordinator.sdk.intents()).toHaveLength(0);
    expect(f.coordinator.sdk.latestEvent('websocket-scope', 'decision')?.data).toMatchObject({
      decisionSource: 'stopped',
      action: null,
      stopReason: 'MODEL_INVALID',
    });
    expect(f.raw.db.prepare('SELECT source,status FROM decisions').get()).toMatchObject({
      source: 'unavailable',
      status: 'failed',
    });
  });

  it('reconnects and retries the same durable command without a second Score request', async () => {
    const submitted: Record<string, unknown>[] = [];
    const urls = await arena((ws, message, connection) => {
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action') {
        submitted.push(message);
        if (connection === 1) ws.terminate();
        else {
          send(ws, {
            type: 'action_ack',
            client_action_id: message.client_action_id,
            status: 'accepted',
          });
          send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
        }
      }
      if (message.type === 'resync_request') resync(ws, 'h1', 'token-1');
    });
    const f = createLive(urls),
      score = vi.spyOn(f.model, 'score');
    await f.runtime.start({ strategy: 'jev', maxHands: 1, reconnectMinMs: 1, reconnectMaxMs: 2 });
    await vi.waitFor(
      () => expect(f.runtime.status().phase, f.runtime.status().lastError ?? '').toBe('stopped'),
      { timeout: 5000 },
    );
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(score).toHaveBeenCalledTimes(1);
    expect(f.coordinator.sdk.intents()).toHaveLength(1);
    expect(f.coordinator.sdk.intents()[0]?.receipt?.status).toBe('completed');
  });

  it('never sends a late answer from obsolete authority and allows the next hand to proceed', async () => {
    let socket: WebSocket | undefined;
    let release!: () => void;
    const oldAnswer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action')
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
    });
    const model = scoreModel(),
      original = model.score.bind(model);
    const score = vi.spyOn(model, 'score').mockImplementationOnce(async (request) => {
      await oldAnswer;
      return original(request);
    });
    const f = createLive(urls, model);
    await f.runtime.start({ strategy: 'jev' });
    await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(1));
    turn(socket!, 2);
    try {
      await vi.waitFor(() =>
        expect(
          urls.messages.filter((message) => message.type === 'action'),
          JSON.stringify({
            error: f.runtime.status().lastError,
            decisions: f.raw.db.prepare('SELECT status,fallback_reason FROM decisions').all(),
          }),
        ).toHaveLength(1),
      );
    } finally {
      release();
    }
    await f.runtime.settleDecisions();
    await vi.waitFor(() =>
      expect(f.coordinator.sdk.events({ types: ['decision.late_model_result'] })).toHaveLength(1),
    );
    expect(score).toHaveBeenCalledTimes(2);
    expect(
      urls.messages
        .filter((message) => message.type === 'action')
        .map((message) => message.hand_id),
    ).toEqual(['h2']);
    expect(f.coordinator.runtime.status().failure).toBeUndefined();
    expect(f.raw.loadDecisionBlock()).toBeNull();
    expect(f.raw.db.prepare("SELECT status FROM decisions WHERE hand_id='h1'").get()?.status).toBe(
      'cancelled',
    );
    expect(f.coordinator.sdk.intents()).toHaveLength(1);
  });
});
