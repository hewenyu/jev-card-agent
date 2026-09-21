import { expect, it, vi } from 'vitest';
import { Controller } from '../src/server/controller.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';

it('does not create a runtime when close overtakes the asynchronous start boundary', async () => {
  const store = new Store(':memory:');
  const controller = new Controller({ ...loadConfig({}), openPokerApiKey: 'local-test' }, store);
  const acquire = vi.spyOn(store, 'acquireLease');
  const request = {
    strategy: 'baseline' as const,
    buyIn: 2000,
    maxHands: 0,
    maxMinutes: 0,
    budgetUsd: 0,
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
