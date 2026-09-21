import { expect, test, type Page } from '@playwright/test';
import type {
  HandDetail,
  Overview,
  RuntimeView,
  SpectatorSnapshot,
  TableView,
} from '../../src/shared/api';

type DealerWindow = Window & { emitDealerSnapshot: (snapshot: SpectatorSnapshot) => void };
const longName = 'Opponent-with-a-long-public-player-name-for-mobile-layout';
function table(): TableView {
  return {
    tableId: 'dealer-table',
    handId: 'dealer-hand',
    street: 'preflop',
    pot: 30,
    board: [],
    heroCards: [],
    heroSeat: 2,
    dealerSeat: 0,
    actorSeat: 2,
    stateSeq: 1,
    complete: false,
    seats: Array.from({ length: 6 }, (_, seat) => ({
      seat,
      name: seat === 4 ? longName : `Player ${seat + 1}`,
      stack: 2000,
      bet: 0,
      folded: false,
      status: 'active',
    })),
  };
}
async function fixture(page: Page) {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const runtime: RuntimeView = {
    running: true,
    status: 'playing',
    mode: 'live',
    runId: 'dealer-run',
    strategy: 'jev',
    error: null,
    table: table(),
  };
  const run = { ...original.runs[0]!, id: 'dealer-run', mode: 'live' as const };
  await page.addInitScript(() => {
    class DealerStream extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
        (window as unknown as DealerWindow).emitDealerSnapshot = (snapshot) => {
          this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }));
        };
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    }
    window.EventSource = DealerStream as unknown as typeof EventSource;
  });
  await page.route('**/api/overview', (route) =>
    route.fulfill({ json: { ...original, runtime, runs: [run] } }),
  );
  await page.route('**/api/runs?*', (route) => route.fulfill({ json: [run] }));
  await page.route('**/api/funding/events*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({ json: { session: null, decisions: [] } }),
  );
  let sequence = 0;
  const send = async (next: TableView) => {
    const snapshot: SpectatorSnapshot = {
      sequence: ++sequence,
      observedAt: new Date().toISOString(),
      runtime: { ...runtime, table: next },
      recentEvents: [],
    };
    await page.evaluate(
      (snapshot) => (window as unknown as DealerWindow).emitDealerSnapshot(snapshot),
      snapshot,
    );
  };
  return { original, runtime, send };
}
async function expectDealer(page: Page, seat: number, name: string) {
  const label = `Seat ${seat + 1} · ${name}`;
  await expect(page.locator('.dealer-summary strong')).toHaveText(label);
  await expect(
    page.getByRole('img', { name: `Dealer button: ${label}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.dealer')).toHaveCount(1);
  await expect(page.locator(`[data-seat="${seat}"] .dealer`)).toHaveText('D');
}
async function expectUnknown(page: Page) {
  await expect(page.locator('.dealer-summary strong')).toHaveText('Not reported for this snapshot');
  await expect(page.locator('.dealer')).toHaveCount(0);
}

test('Live follows reported dealer changes and clears an unknown button without predicting a seat', async ({
  page,
}) => {
  const { send } = await fixture(page);
  await page.goto('/#live');
  await expectDealer(page, 0, 'Player 1');
  await send({ ...table(), handId: 'dealer-hand-2', stateSeq: 2, dealerSeat: 4 });
  await expectDealer(page, 4, longName);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.dealer-summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('dealer-live-mobile.png') });
  await send({ ...table(), handId: 'dealer-hand-3', stateSeq: 3, dealerSeat: null });
  await expectUnknown(page);
  // A server-reported seat is still identifiable while its player details are absent.
  await send({ ...table(), handId: 'dealer-hand-3', stateSeq: 4, dealerSeat: 1, seats: [] });
  await expectDealer(page, 1, 'Player not reported');
});

test('Replay uses the dealer known at its cursor and never final metadata or a future button', async ({
  page,
}) => {
  const { original } = await fixture(page);
  const hand = {
    ...original.recentHands[0]!,
    id: 'dealer-history',
    runId: 'dealer-run',
    tableId: 'dealer-table',
    handNumber: 1,
    dealerSeat: 5,
  };
  const events: HandDetail['events'] = [
    {
      id: 'join',
      type: 'table_joined',
      receivedAt: '2026-09-21T00:00:00Z',
      payload: { table_id: 'dealer-table', seats: table().seats },
    },
    {
      id: 'start',
      type: 'hand_start',
      receivedAt: '2026-09-21T00:00:01Z',
      payload: { hand_id: hand.id, dealer_seat: 1 },
    },
    {
      id: 'turn',
      type: 'your_turn',
      receivedAt: '2026-09-21T00:00:02Z',
      payload: { players: table().seats },
    },
    {
      id: 'unknown',
      type: 'resync_response',
      receivedAt: '2026-09-21T00:00:03Z',
      payload: { snapshot: { dealer_seat: null, seats: table().seats } },
    },
    {
      id: 'reported',
      type: 'resync_response',
      receivedAt: '2026-09-21T00:00:04Z',
      payload: { snapshot: { dealer_seat: 4, seats: table().seats } },
    },
  ];
  const detail: HandDetail = { hand, events, decisions: [] };
  await page.route('**/api/hands?*', (route) => route.fulfill({ json: [hand] }));
  await page.route('**/api/hands/*', (route) => route.fulfill({ json: detail }));
  await page.goto('/#replay');
  await expectUnknown(page);
  const next = page.getByRole('button', { name: 'Next event', exact: true });
  await next.click();
  await expectDealer(page, 1, 'Player 2');
  await next.click();
  await expectDealer(page, 1, 'Player 2');
  await next.click();
  await expectUnknown(page);
  await next.click();
  await expectDealer(page, 4, longName);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.dealer-summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('dealer-replay-mobile.png') });
  await page.getByRole('button', { name: 'Previous event', exact: true }).click();
  await expectUnknown(page);
  await page.getByRole('slider', { name: 'Replay event' }).focus();
  await page.keyboard.press('Home');
  await expectUnknown(page);
  await expect(page.getByRole('slider', { name: 'Replay event' })).toHaveValue('0');
});
