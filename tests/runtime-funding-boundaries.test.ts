import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenPokerClient, type SeasonBalance } from '../src/openpoker/client.js';
import type { FundingEventView } from '../src/shared/api.js';
import { arena, createRuntime, joined, MemoryStore, send, turn } from './helpers/runtime-arena.js';

const initial: SeasonBalance = {
  chipBalance: 5000,
  chipsAtTable: 0,
  autoRebuy: true,
  pro: false,
  score: 88,
  seasonId: 'season-a',
};
function deferred() {
  let resolve!: (balance: SeasonBalance) => void;
  const promise = new Promise<SeasonBalance>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
class FundingStore extends MemoryStore {
  funding: FundingEventView[] = [];
  finishes = 0;
  saveFundingEvent(event: FundingEventView) {
    this.funding.push(event);
  }
  finishRun() {
    this.finishes++;
  }
}
afterEach(() => vi.restoreAllMocks());

describe('runtime authoritative account boundaries', () => {
  it('reconciles startup before connecting and waits for saved final departure before emitting stopped', async () => {
    const startup = deferred();
    const final = deferred();
    let departed = false;
    let finalRequested = false;
    const read = vi
      .spyOn(OpenPokerClient.prototype, 'seasonBalance')
      .mockImplementationOnce(() => startup.promise)
      .mockImplementation(async () => {
        if (departed) {
          finalRequested = true;
          return final.promise;
        }
        return initial;
      });
    const urls = await arena((ws, message) => {
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
      if (message.type === 'leave_table') departed = true;
    });
    const store = new FundingStore();
    const { runtime } = createRuntime(urls, store);
    const stopped = vi.fn();
    runtime.on('stopped', stopped);
    const started = runtime.start({ strategy: 'baseline', maxHands: 1 });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(urls.messages).toHaveLength(0);
    startup.resolve(initial);
    await started;
    await vi.waitFor(() => expect(finalRequested).toBe(true));
    expect(store.finishes).toBe(0);
    expect(stopped).not.toHaveBeenCalled();
    expect(runtime.status().phase).toBe('stopping');
    expect(store.funding.some((event) => event.syncReason === 'before_join')).toBe(true);
    final.resolve({ ...initial, chipBalance: 5040, chipsAtTable: 0, score: 128 });
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
    expect(store.finishes).toBe(1);
    expect(store.funding.at(-1)).toMatchObject({
      syncReason: 'after_leave',
      availableAfter: 5040,
      chipsAtTable: 0,
      seasonScore: 128,
    });
    expect(runtime.status().funding).toMatchObject({
      availableChips: 5040,
      chipsAtTable: 0,
      seasonScore: 128,
      status: 'current',
    });
  });

  it('finishes with an explicit stale account status when the confirmed-departure reconciliation fails', async () => {
    let departed = false;
    vi.spyOn(OpenPokerClient.prototype, 'seasonBalance').mockImplementation(async () => {
      if (departed) throw new Error('official account unavailable');
      return initial;
    });
    const urls = await arena((ws, message) => {
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
      if (message.type === 'leave_table') departed = true;
    });
    const store = new FundingStore();
    const { runtime } = createRuntime(urls, store);
    await runtime.start({ strategy: 'baseline', maxHands: 1 });
    await vi.waitFor(() => expect(runtime.status().phase).toBe('stopped'));
    expect(runtime.status().lastError).toContain('Final official account reconciliation failed');
    expect(runtime.status().funding).toMatchObject({ seasonScore: 88, status: 'stale' });
    expect(store.funding.some((event) => event.syncReason === 'after_leave')).toBe(false);
    expect(store.finishes).toBe(1);
  });
});
