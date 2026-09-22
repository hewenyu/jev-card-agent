import { mockOverview } from './dashboard-fixture';
import { expect, test, type Page } from '@playwright/test';
import type { Overview, RuntimeView, SpectatorSnapshot } from '../../src/shared/api';

type ChipWindow = Window & { emitChipSnapshot: (snapshot: SpectatorSnapshot) => void };

async function fixture(page: Page) {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const at = Date.now();
  const runtime: RuntimeView = {
    running: true,
    status: 'playing',
    mode: 'live',
    runId: 'chip-label-run',
    strategy: 'jev',
    error: null,
    funding: {
      availableChips: 7250,
      chipsAtTable: 20000,
      autoRebuy: true,
      rebuyAmount: 1500,
      rebuyCooldownSeconds: 300,
      rebuyAvailableAt: null,
      lastRebuyAt: null,
      updatedAt: new Date(at).toISOString(),
      observedAt: new Date(at).toISOString(),
      status: 'current',
    },
    table: {
      tableId: 'chip-label-table',
      handId: 'chip-label-hand',
      street: 'flop',
      pot: 4050,
      board: ['2h', '3d', '4s'],
      heroCards: ['Ah', 'Kd'],
      heroSeat: 4,
      dealerSeat: 1,
      actorSeat: 4,
      stateSeq: 1,
      complete: false,
      seats: Array.from({ length: 6 }, (_, seat) => ({
        seat,
        name: seat === 4 ? 'Jev agent' : `Opponent ${seat + 1}`,
        stack: seat === 4 ? 12345 : 22222 + seat,
        bet: seat === 4 ? 1500 : seat === 1 ? 2550 : 0,
        folded: false,
        status: 'active',
      })),
    },
  };
  const state = { runtime, reads: 0 };
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
        (window as unknown as ChipWindow).emitChipSnapshot = (snapshot) => {
          this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }));
        };
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    }
    window.EventSource = TestEventSource as unknown as typeof EventSource;
  });
  await mockOverview(page, (route) => {
    state.reads++;
    return route.fulfill({
      json: {
        ...original,
        runtime: state.runtime,
        runs: [{ ...original.runs[0]!, id: runtime.runId, mode: 'live' }],
      },
    });
  });
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({ json: { session: null, decisions: [] } }),
  );
  await page.route('**/api/funding/events*', (route) => route.fulfill({ json: [] }));
  let sequence = 0;
  const send = async () => {
    const snapshot: SpectatorSnapshot = {
      sequence: ++sequence,
      observedAt: new Date().toISOString(),
      runtime: state.runtime,
      recentEvents: [],
    };
    await page.evaluate(
      (value) => (window as unknown as ChipWindow).emitChipSnapshot(value),
      snapshot,
    );
  };
  return { state, send, at };
}

async function expectAmounts(
  page: Page,
  account: string,
  stack: string,
  bet: string,
  atTable: string,
) {
  await expect(page.getByTestId('account-available')).toHaveText(account);
  await expect(page.getByTestId('seat-stack')).toHaveText(stack);
  await expect(page.getByTestId('seat-bet')).toHaveText(bet);
  await expect(page.getByTestId('account-at-table')).toHaveText(atTable);
}

test('available chips, street bets and account snapshots keep distinct labels and server amounts', async ({
  page,
}) => {
  const { state, send, at } = await fixture(page);
  await page.goto('/#live');
  await expect(page.locator('.pot > span')).toHaveText('POT');
  await expect(page.locator('.pot strong')).toHaveText('4,050');
  await expect(page.locator('.funding-balances > div')).toHaveCount(4);
  await expectAmounts(page, '7,250', '12,345', '1,500', '20,000');
  for (const player of state.runtime.table!.seats) {
    const seat = page.locator(`[data-seat="${player.seat}"]`);
    await expect(seat.getByText('Available', { exact: true })).toBeVisible();
    await expect(seat.locator('.seat-info strong')).toHaveText(
      player.stack.toLocaleString('en-US'),
    );
    await expect(seat.locator('.seat-bet')).toHaveText(`Bet ${player.bet.toLocaleString('en-US')}`);
    await expect(seat.locator('.seat-bet strong')).toHaveText(player.bet.toLocaleString('en-US'));
  }
  await expect(page.locator('.funding-balances')).toContainText('Available to bet');
  await expect(page.locator('.funding-balances')).toContainText('Current street bet');

  // Authoritative seat balances change independently from the slower REST account snapshot.
  state.runtime.table = {
    ...state.runtime.table!,
    stateSeq: 2,
    pot: 4650,
    seats: state.runtime.table!.seats.map((seat) => ({
      ...seat,
      stack: seat.seat === 4 ? 12045 : seat.seat === 1 ? 21923 : seat.stack,
      bet: seat.seat === 4 ? 1800 : seat.seat === 1 ? 2850 : seat.bet,
    })),
  };
  await send();
  await expectAmounts(page, '7,250', '12,045', '1,800', '20,000');
  await expect(page.locator('.seat-4 .seat-info strong')).toHaveText('12,045');
  await expect(page.locator('.seat-4 .seat-bet')).toHaveText('Bet 1,800');
  await expect(page.locator('.seat-1 .seat-info strong')).toHaveText('21,923');
  await expect(page.locator('.seat-1 .seat-bet')).toHaveText('Bet 2,850');

  state.runtime.funding = {
    ...state.runtime.funding!,
    availableChips: 7100,
    chipsAtTable: 18000,
    updatedAt: new Date(at + 1000).toISOString(),
    observedAt: new Date(at + 1000).toISOString(),
  };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expectAmounts(page, '7,100', '12,045', '1,800', '18,000');
  await expect(page.locator('.seat-4 .seat-info strong')).toHaveText('12,045');
  await expect(page.locator('.seat-1 .seat-bet')).toHaveText('Bet 2,850');
});

test('settlement keeps a labeled settled pot, clears current bets and omits bets for empty seats', async ({
  page,
}) => {
  const { state, send } = await fixture(page);
  await page.goto('/#live');
  await expect(page.locator('.seat-4 .seat-bet')).toHaveText('Bet 1,500');
  state.runtime.table = {
    ...state.runtime.table!,
    complete: true,
    actorSeat: null,
    stateSeq: 2,
    seats: state.runtime.table!.seats.map((seat) => ({
      ...seat,
      stack: seat.seat === 4 ? 16395 : seat.stack,
      bet: 0,
    })),
  };
  await send();
  await expect(page.locator('.pot > span')).toHaveText('SETTLED POT');
  await expect(page.locator('.pot strong')).toHaveText('4,050');
  await expect(page.getByTestId('seat-bet')).toHaveText('0');
  await expect(page.getByTestId('seat-stack')).toHaveText('16,395');
  await expect(page.locator('.seat-bet')).toHaveCount(6);
  for (const seatBet of await page.locator('.seat-bet').all()) {
    await expect(seatBet).toHaveText('Bet 0');
  }
  state.runtime.table = {
    ...state.runtime.table!,
    stateSeq: 3,
    seats: state.runtime.table!.seats.filter((seat) => seat.seat !== 2),
  };
  await send();
  await expect(page.locator('.seat-2 .seat-info strong')).toHaveText('—');
  await expect(page.locator('.seat-2 .seat-bet')).toHaveCount(0);
  await expect(page.locator('.seat-bet')).toHaveCount(5);
});

for (const width of [1440, 390]) {
  test(`chip labels, amounts and hero cards fit the table at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto('/#live');
    await expect(page.locator('.seat-4 .seat-info strong')).toHaveText('12,345');
    await expect(page.locator('.seat-4 .hero-hole .playing-card')).toHaveCount(2);
    const scene = (await page.locator('.poker-scene').boundingBox())!;
    for (const selector of ['.seat-info strong', '.seat-bet', '.seat-info', '.hero-hole']) {
      for (const element of await page.locator(`.poker-scene ${selector}`).all()) {
        await expect(element).toBeVisible();
        const box = (await element.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(scene.x);
        expect(box.x + box.width).toBeLessThanOrEqual(scene.x + scene.width);
      }
    }
    for (const amount of await page.locator('.seat-info strong, .seat-bet').all()) {
      expect(await amount.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    }
    await expectAmounts(page, '7,250', '12,345', '1,500', '20,000');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: test.info().outputPath(`chip-labels-${width}.png`) });
    await page.screenshot({
      path: test.info().outputPath(`chip-labels-${width}-full.png`),
      fullPage: true,
    });
  });
}
