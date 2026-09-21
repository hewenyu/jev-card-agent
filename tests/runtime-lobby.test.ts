import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPokerClient, type SeasonBalance } from '../src/openpoker/client.js';
import { LobbyLifecycle } from '../src/runtime/lobby.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture(balance = 1500) {
  let ready = true;
  const season: SeasonBalance = {
    chipBalance: balance,
    chipsAtTable: 0,
    pro: false,
    autoRebuy: true,
  };
  const client = new OpenPokerClient({ apiKey: 'unused' });
  const read = vi.spyOn(client, 'seasonBalance').mockImplementation(async () => ({ ...season }));
  const active = vi.spyOn(client, 'activeGame').mockResolvedValue({
    playing: false,
    table_id: undefined,
    seat: undefined,
    stack_chips: undefined,
  });
  const rebuy = vi.spyOn(client, 'rebuy').mockImplementation(async () => {
    season.chipBalance = 1500;
    return { status: 'confirmed' };
  });
  const hooks = {
    ready: () => ready,
    buyIn: () => 2000,
    autoRebuy: () => true,
    assertLease: vi.fn(),
    send: vi.fn(),
    join: vi.fn(),
    recover: vi.fn(),
    cooldown: vi.fn(),
    fail: vi.fn(),
    fundingRebuy: vi.fn(),
  };
  const lobby = new LobbyLifecycle(client, hooks);
  return {
    lobby,
    hooks,
    client,
    season,
    read,
    active,
    rebuy,
    stop: () => {
      ready = false;
      lobby.cancel();
    },
  };
}

describe('free-chip continuous lobby lifecycle', () => {
  it('buys in for 1500 after a rebuy instead of looping on the configured 2000', async () => {
    const { lobby, hooks, rebuy } = fixture();
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.join).toHaveBeenCalledExactlyOnceWith(1500);
    lobby.requestJoin();
    lobby.confirmed();
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.join).toHaveBeenCalledTimes(1);
    expect(rebuy).not.toHaveBeenCalled();
  });

  it('waits for server auto-rebuy first, then recovers a missed rebuy with fresh eligibility and reloads the balance', async () => {
    const { lobby, hooks, rebuy, active, read } = fixture(0);
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(rebuy).not.toHaveBeenCalled();
    expect(hooks.join).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuy).toHaveBeenCalledTimes(1);
    expect(active.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(hooks.fundingRebuy).toHaveBeenCalledExactlyOnceWith({ status: 'confirmed' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(hooks.join).toHaveBeenCalledExactlyOnceWith(1500);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('obeys REST Retry-After and survives a disconnect without restarting the cooldown', async () => {
    const { lobby, hooks, rebuy } = fixture(0);
    rebuy.mockResolvedValueOnce({ status: 'cooldown', retryAfterMs: 120_000 });
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rebuy).toHaveBeenCalledTimes(1);
    lobby.cancel();
    expect(hooks.fundingRebuy).toHaveBeenCalledExactlyOnceWith({
      status: 'cooldown',
      retryAfterMs: 120_000,
    });
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(rebuy).toHaveBeenCalledTimes(1);
    expect(hooks.join).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(rebuy).toHaveBeenCalledTimes(2);
    expect(hooks.join).toHaveBeenCalledExactlyOnceWith(1500);
  });

  it('lets authoritative auto-rebuy confirmation cancel polling and enter the next lobby once', async () => {
    const { lobby, hooks, season, rebuy } = fixture(0);
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(0);
    lobby.scheduled({ type: 'auto_rebuy_scheduled', cooldown_seconds: 300 });
    season.chipBalance = 1500;
    lobby.confirmed();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_001);
    expect(hooks.join).toHaveBeenCalledExactlyOnceWith(1500);
    expect(rebuy).not.toHaveBeenCalled();
  });

  it('does not rebuy while chips or a funded seat remain at the table', async () => {
    const { lobby, hooks, season, active, rebuy } = fixture(100);
    season.chipsAtTable = 2000;
    active.mockResolvedValue({
      playing: true,
      table_id: 'active-table',
      seat: 1,
      stack_chips: 2000,
    });
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hooks.recover).toHaveBeenCalledTimes(1);
    expect(rebuy).not.toHaveBeenCalled();
    expect(hooks.send).not.toHaveBeenCalledWith({ type: 'leave_table' });
  });

  it('cancels scheduled rebuy and pending balance reads during strict drain', async () => {
    const scheduled = fixture(0);
    scheduled.lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(0);
    scheduled.stop();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(scheduled.rebuy).not.toHaveBeenCalled();
    expect(scheduled.hooks.join).not.toHaveBeenCalled();
    const pending = fixture();
    let resolve: ((value: SeasonBalance) => void) | undefined;
    pending.read.mockImplementation(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    pending.lobby.requestJoin();
    pending.stop();
    expect(pending.read.mock.calls[0]?.[0].aborted).toBe(true);
    resolve?.(pending.season);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.hooks.join).not.toHaveBeenCalled();
  });
  it('reconciles a racing automatic rebuy without repeatedly minting or joining', async () => {
    const { lobby, hooks, season, rebuy } = fixture(0);
    rebuy.mockImplementationOnce(async () => {
      season.chipBalance = 1500;
      return { status: 'not_eligible' };
    });
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rebuy).toHaveBeenCalledTimes(1);
    lobby.confirmed();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rebuy).toHaveBeenCalledTimes(1);
    expect(hooks.join).toHaveBeenCalledExactlyOnceWith(1500);
  });

  it('backs off repeated insufficient-funds joins instead of spinning indefinitely', async () => {
    const { lobby, hooks } = fixture();
    lobby.requestJoin();
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [1000, 2000, 4000]) {
      const count = hooks.join.mock.calls.length;
      lobby.insufficientFunds();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(hooks.join).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.join).toHaveBeenCalledTimes(count + 1);
    }
    lobby.cancel();
  });
});
