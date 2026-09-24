import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createInitialState } from '../src/core/index.js';
import type { DecisionContext, PokerState, Proposal } from '../src/core/types.js';
import type { OpponentMemory, MemoryStreetStats } from '../src/core/opponent-memory.js';
import type { KnowledgeBinding } from '../src/knowledge/types.js';
import { authorityKey, decisionStateKey } from '../src/runtime/authority.js';
import { decide, type DecisionTask } from '../src/evaluation/legacy/decision.js';
import type { DecisionTiming } from '../src/runtime/timing.js';
import type { RuntimeStore } from '../src/runtime/types.js';
import { arena, createRuntime, joined, MemoryStore, send, turn } from './helpers/runtime-arena.js';

const choice: Proposal = {
  source: 'jev',
  candidateId: 'check',
  selected: 'check',
  explanation: 'selected by Jev',
  latencyMs: 1,
};
function task(): DecisionTask {
  const state: PokerState = {
    ...createInitialState(),
    tableId: 't1',
    handId: 'h1',
    turnToken: 'token-1',
    heroSeat: 0,
    actorSeat: 0,
    holeCards: ['Ah', 'Kd'],
    validActions: [{ action: 'check' }, { action: 'fold' }],
    seats: [{ seat: 0, name: 'hero', stack: 2000, bet: 0, status: 'active' }],
  };
  return {
    key: authorityKey(state),
    state,
    controller: new AbortController(),
    deadlineAt: Date.now() + 10_000,
    recovered: false,
    opponents: [],
  };
}
function binding(): KnowledgeBinding {
  return {
    pin: {
      tableId: 't1',
      handId: 'h1',
      knowledgeVersion: 'fixed-v1',
      snapshotHash: 'fixed-hash',
      evidenceEventId: 12,
      pinnedAt: '2026-09-01T00:00:00.000Z',
      admissibleAt: '2026-09-01T00:00:00.000Z',
      reason: 'published',
      opponentMemory: [],
      strategyCards: [],
    },
    snapshot: {
      version: 'fixed-v1',
      contentHash: 'fixed-hash',
      source: 'deterministic',
      rulesetVersion: 'test',
      contextSchemaVersion: 'test',
      evidenceEventId: 12,
      evidenceCutoff: '2026-08-31T23:59:00.000Z',
      publishedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: null,
      opponents: [],
      cards: [],
      validation: [],
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe('fast decision invariants', () => {
  it('counts synchronous preparation against the original decision deadline', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const current = { ...task(), receivedAt: 980, decisionDeadlineAt: 1100 };
    const policy = { decide: vi.fn(async () => choice) };
    const result = await decide(
      current,
      {
        apiKey: 'unused',
        policy,
        store: {
          sessionTurns: () => {
            now += 150;
            return [];
          },
        } as unknown as RuntimeStore,
      },
      'run',
      100,
    );
    expect(policy.decide).not.toHaveBeenCalled();
    expect(result?.action).toBeNull();
    expect(result?.decision).toMatchObject({
      status: 'failed',
      fallbackReason: 'insufficient_time',
      timing: { preparationMs: 170, providerMs: 0 },
    });
  });

  it('reads already pinned knowledge without rebuilding historical opponent memory', async () => {
    const pinned = binding();
    const rebuild = vi.fn(() => {
      throw new Error('must never rebuild in the fast path');
    });
    const policy = { decide: vi.fn(async (_context: DecisionContext) => choice) };
    const result = await decide(
      task(),
      {
        apiKey: 'unused',
        policy,
        store: {
          pinKnowledge: () => pinned,
          getOpponentMemory: rebuild,
        } as unknown as RuntimeStore,
      },
      'run',
      1000,
    );
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(result?.decision.context.knowledge?.pin).toEqual(pinned.pin);
    expect(result?.decision.context.knowledge?.snapshot).not.toHaveProperty('opponents');
    expect(result?.decision.context.knowledge?.snapshot).not.toHaveProperty('cards');
    expect(result?.decision.context.opponents).toEqual([]);
    expect(result?.action?.decisionSource).toBe('jev');
  });

  it('selects a late-arriving opponent from the same pinned snapshot without using a new version', async () => {
    const pinned = binding();
    const street: MemoryStreetStats = {
      observedActions: 3,
      raises: 1,
      calls: 1,
      checks: 1,
      folds: 0,
      allIns: 0,
      facedBetObserved: 1,
      foldedToObservedBet: 0,
      sizedContributions: 1,
      contributionToPotSum: 0.5,
    };
    const opponent: OpponentMemory = {
      version: 'completed-opponent-encounters-v1',
      name: 'other',
      asOf: pinned.snapshot.evidenceCutoff,
      sampledHands: 2,
      sampleLimit: 200,
      sampleCapped: false,
      firstCompletedAt: pinned.snapshot.evidenceCutoff,
      lastCompletedAt: pinned.snapshot.evidenceCutoff,
      shownHands: 0,
      streets: { preflop: street, flop: street, turn: street, river: street },
      showdowns: [],
      recentEncountersWithHero: [],
      caveats: [],
    };
    pinned.snapshot.opponents = [opponent];
    const dependencies = {
      apiKey: 'unused',
      policy: { decide: async () => choice },
      store: { pinKnowledge: () => pinned } as unknown as RuntimeStore,
    };
    const first = await decide(task(), dependencies, 'run', 1000);
    const later = task();
    later.state.seats.push({ seat: 1, name: 'other', stack: 2000, bet: 0, status: 'active' });
    const second = await decide(later, dependencies, 'run', 1000);
    expect(first?.decision.context.opponentMemory).toEqual([]);
    expect(second?.decision.context.opponentMemory).toEqual([opponent]);
    expect(second?.decision.context.knowledge?.pin.opponentMemory).toEqual([opponent]);
    expect(second?.decision.context.knowledge?.pin.snapshotHash).toBe(
      first?.decision.context.knowledge?.pin.snapshotHash,
    );
    expect(pinned.pin.opponentMemory).toEqual([]);
  });

  it('rejects a provider result after the absolute decision deadline even before the timer runs', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const current = { ...task(), decisionDeadlineAt: 1050 };
    const result = await decide(
      current,
      {
        apiKey: 'unused',
        store: {} as RuntimeStore,
        policy: {
          decide: async () => {
            now = 1060;
            return choice;
          },
        },
      },
      'run',
      1000,
    );
    expect(result?.action).toBeNull();
    expect(result?.decision).toMatchObject({
      status: 'failed',
      fallbackReason: 'decision_deadline_elapsed',
    });
  });

  it('includes table and decision facts in identity without sequence or folded-player balance noise', () => {
    const original = task().state;
    original.seats.push({
      seat: 1,
      name: 'folded',
      stack: 100,
      bet: 20,
      status: 'active',
      folded: true,
    });
    const noise = structuredClone(original);
    noise.lastTableSeq += 20;
    noise.seats[1]!.stack = 200;
    expect(decisionStateKey(noise)).toBe(decisionStateKey(original));
    const changed = structuredClone(original);
    changed.pot += 20;
    expect(decisionStateKey(changed)).not.toBe(decisionStateKey(original));
    expect(authorityKey({ ...original, tableId: 't2' })).not.toBe(authorityKey(original));
  });

  it('never submits a still-legal answer for a changed decision state with the same token', async () => {
    let socket: WebSocket | undefined;
    let finish: ((proposal: Proposal) => void) | undefined;
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const { runtime, store } = createRuntime(urls, undefined, {
      decide: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await runtime.start({ strategy: 'jev' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    send(socket!, {
      type: 'table_state',
      table_id: 't1',
      hand_id: 'h1',
      table_seq: 105,
      actor_seat: 0,
      pot: 80,
      hero: { seat: 0, valid_actions: [{ action: 'check' }, { action: 'fold' }] },
    });
    await vi.waitFor(() => expect(runtime.state.pot).toBe(80));
    finish!(choice);
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
    expect(store.decisions[0]).toMatchObject({
      status: 'failed',
      fallbackReason: 'decision_state_changed',
    });
    expect(urls.messages.some((message) => message.type === 'action')).toBe(false);
    send(socket!, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
  });

  it('pins before model calls and records send/ACK timing while account updates do not cancel the turn', async () => {
    class TimedStore extends MemoryStore {
      pins: PokerState[] = [];
      timings = new Map<string, DecisionTiming>();
      pinKnowledge(state: PokerState) {
        this.pins.push(structuredClone(state));
        return binding();
      }
      saveDecisionTiming(id: string, value: DecisionTiming) {
        this.timings.set(id, structuredClone(value));
      }
    }
    const store = new TimedStore();
    let socket: WebSocket | undefined;
    let finish: ((proposal: Proposal) => void) | undefined;
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action') {
        send(ws, {
          type: 'action_ack',
          client_action_id: message.client_action_id,
          status: 'accepted',
        });
        send(ws, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
      }
    });
    const policy = {
      decide: vi.fn(
        () =>
          new Promise<Proposal>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const { runtime } = createRuntime(urls, store, policy);
    await runtime.start({ strategy: 'jev', maxHands: 1 });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(store.pins[0]?.handId).toBe('h1');
    expect(store.pins[0]?.turnToken).toBeNull();
    send(socket!, { type: 'rebuy_confirmed', amount: 1500, chip_balance: 1700 });
    finish!(choice);
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect([...store.actions.values()][0]?.status).toBe('accepted');
    const timing = store.timings.get(store.decisions[0]!.id)!;
    expect(timing.firstSentAt).toBeDefined();
    expect(timing.acknowledgedAt).toBeDefined();
    expect(timing.receiptToSendMs).toBeGreaterThanOrEqual(timing.preparationMs);
    expect(timing.persistenceMs).toBeGreaterThanOrEqual(0);
    expect(timing.ackMs).toBeGreaterThanOrEqual(0);
  });

  it('includes event persistence before authorization in the decision timeout', async () => {
    class SlowReceiptStore extends MemoryStore {
      appendEvent(...args: unknown[]) {
        super.appendEvent(...args);
        if ((args[1] as { type: string }).type === 'your_turn')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35);
      }
    }
    let socket: WebSocket | undefined;
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
    });
    const policy = { decide: vi.fn(async () => choice) };
    const { runtime, store } = createRuntime(urls, new SlowReceiptStore(), policy);
    await runtime.start({ strategy: 'jev', decisionTimeoutMs: 10 });
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
    expect(policy.decide).not.toHaveBeenCalled();
    expect(store.decisions[0]?.timing?.preparationMs).toBeGreaterThanOrEqual(30);
    expect(store.actions.size).toBe(0);
    send(socket!, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
  });

  it('does not resend a durable answer after the same token acquires different execution facts', async () => {
    let socket: WebSocket | undefined;
    const urls = await arena((ws, message) => {
      socket = ws;
      if (message.type === 'join_lobby') {
        joined(ws);
        turn(ws, 1);
      }
      if (message.type === 'action') ws.terminate();
      if (message.type === 'resync_request') {
        send(ws, {
          type: 'resync_response',
          table_id: 't1',
          hand_id: 'h1',
          to_table_seq: 110,
          role: 'player',
          replayed_events: [],
          snapshot: {
            type: 'table_state',
            table_id: 't1',
            hand_id: 'h1',
            actor_seat: 0,
            street: 'preflop',
            pot: 80,
            hero: {
              seat: 0,
              turn_token: 'token-1',
              hole_cards: ['Ah', 'Kd'],
              valid_actions: [{ action: 'check' }, { action: 'fold' }],
            },
            seats: [
              { seat: 0, name: 'hero', stack: 2000, bet: 0, status: 'active' },
              { seat: 1, name: 'other', stack: 2000, bet: 0, status: 'active' },
            ],
          },
        });
      }
    });
    const policy = { decide: vi.fn(async () => choice) };
    const { runtime, store } = createRuntime(urls, new MemoryStore(), policy);
    await runtime.start({ strategy: 'jev', reconnectMinMs: 1, reconnectMaxMs: 2 });
    await vi.waitFor(() => expect(store.blocks).toHaveLength(1));
    expect(store.blocks[0]?.reason).toBe('pending_decision_state_changed');
    expect(urls.messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(policy.decide).toHaveBeenCalledTimes(1);
    send(socket!, { type: 'hand_result', table_id: 't1', hand_id: 'h1', table_seq: 120 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
  });
});
