import { expect, it, vi } from 'vitest';
import { Controller } from '../src/server/controller.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';
import type { PokerRuntime } from '../src/runtime/runtime.js';
import type { LiveDecisionCoordinator } from '../src/duelloop/live/coordinator.js';

it('maintenance pause waits for stopped runtime decisions and SDK outbox before backup', async () => {
  const store = new Store(':memory:');
  const controller = new Controller(loadConfig({}), store);
  const view = controller.view();
  vi.spyOn(controller, 'view').mockReturnValue({ ...view, running: false });
  let settle!: () => void;
  let flush!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const flushed = new Promise<void>((resolve) => {
    flush = resolve;
  });
  const close = vi.fn(() => flushed);
  controller.runtime = { settleDecisions: () => settled } as unknown as PokerRuntime;
  controller.coordinator = { close } as unknown as LiveDecisionCoordinator;
  vi.spyOn(controller, 'frameworkView').mockReturnValue(undefined);
  let completed = false;
  const pause = controller.pauseResearch().then(() => {
    completed = true;
  });
  try {
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    settle();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    flush();
    await pause;
    expect(completed).toBe(true);
  } finally {
    settle();
    flush();
    await pause;
    controller.runtime = null;
    await controller.close();
    store.close();
  }
});

it('public framework status does not load all historical execution intents', async () => {
  const store = new Store(':memory:');
  const controller = new Controller(loadConfig({}), store);
  const scan = vi.spyOn(controller.frameworkControls.store, 'intents').mockImplementation(() => {
    throw new Error('Full execution history scan is forbidden on the public read path');
  });
  const validationScan = vi
    .spyOn(controller.frameworkControls.store, 'scopeStatus')
    .mockImplementation(() => {
      throw new Error('Public polling must not revalidate all historical releases');
    });
  try {
    expect(controller.frameworkView()?.unresolvedIntents).toBe(0);
    expect(scan).not.toHaveBeenCalled();
    expect(validationScan).not.toHaveBeenCalled();
  } finally {
    await controller.close();
    store.close();
  }
});

it('does not create a runtime when close overtakes the asynchronous start boundary', async () => {
  const store = new Store(':memory:');
  const controller = new Controller(
    { ...loadConfig({}), openPokerApiKey: 'local-test', jevApiKey: 'fixture' },
    store,
  );
  const acquire = vi.spyOn(store, 'acquireLease');
  const request = {
    strategy: 'jev' as const,
    buyIn: 2000,
    maxHands: 0,
    maxMinutes: 0,

    autoRebuy: true,
  };
  try {
    const start = controller.start(request);
    const rejected = expect(start).rejects.toThrow('Controller is closing');
    await controller.close();
    await rejected;
    expect(acquire).not.toHaveBeenCalled();
    expect(controller.view().running).toBe(false);
    expect(controller.runtime).toBeNull();
    await expect(controller.start(request)).rejects.toThrow('Controller is closing');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  } finally {
    store.close();
  }
});
