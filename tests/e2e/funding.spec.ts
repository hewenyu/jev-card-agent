import { expect, test, type Page } from '@playwright/test';
import type {
  FundingEventView,
  FundingView,
  Overview,
  RuntimeView,
  SpectatorSnapshot,
} from '../../src/shared/api';

type StreamWindow = Window & { emitFundingSnapshot: (snapshot: SpectatorSnapshot) => void };

async function fixture(page: Page) {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const base = Date.now();
  const funding = (changes: Partial<FundingView> = {}): FundingView => ({
    availableChips: 0,
    chipsAtTable: 0,
    autoRebuy: true,
    rebuyAmount: 1500,
    rebuyCooldownSeconds: 120,
    rebuyAvailableAt: new Date(base + 120_000).toISOString(),
    lastRebuyAt: null,
    updatedAt: new Date(base).toISOString(),
    observedAt: new Date(base).toISOString(),
    status: 'current',
    ...changes,
  });
  const runtime: RuntimeView = {
    running: true,
    status: 'cooldown',
    mode: 'live',
    runId: 'funding-run',
    strategy: 'jev',
    table: null,
    error: null,
    funding: funding(),
  };
  const state = {
    runtime,
    requests: 0,
    overviewError: false,
    events: [] as FundingEventView[],
    eventRequests: 0,
    historyError: false,
  };
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
        (window as unknown as StreamWindow).emitFundingSnapshot = (snapshot) => {
          this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }));
        };
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    }
    window.EventSource = TestEventSource as unknown as typeof EventSource;
  });
  await page.route('**/api/overview', (route) => {
    state.requests++;
    return state.overviewError
      ? route.fulfill({ status: 503, json: { error: 'Account refresh unavailable' } })
      : route.fulfill({
          json: {
            ...original,
            runtime: state.runtime,
            runs: [
              {
                ...original.runs[0],
                id: 'funding-run',
                mode: 'live',
                netChips: -450,
                settledHands: 1,
              },
            ],
          },
        });
  });
  await page.route('**/api/runs/*/performance', (route) =>
    route.fulfill({
      json: {
        runId: 'funding-run',
        settledHands: 1,
        wonHands: 0,
        excludedHands: 0,
        netChips: -450,
        winRate: 0,
        score: null,
        scoreObservedAt: null,
        profitPoints: [
          { at: new Date(base).toISOString(), handNumber: 1, settledHands: 1, netChips: -450 },
        ],
        scorePoints: [],
      },
    }),
  );
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({ json: { session: null, decisions: [] } }),
  );
  await page.route('**/api/funding/events*', (route) => {
    state.eventRequests++;
    const query = new URL(route.request().url()).searchParams;
    const before = query.get('before');
    const offset = before ? state.events.findIndex((event) => event.id === before) + 1 : 0;
    const events = state.events.slice(offset, offset + Number(query.get('limit') || 8));
    return state.historyError
      ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
      : route.fulfill({ json: events });
  });
  let sequence = 0;
  const send = async (value: RuntimeView) => {
    const snapshot: SpectatorSnapshot = {
      sequence: ++sequence,
      observedAt: new Date().toISOString(),
      runtime: value,
      recentEvents: [],
    };
    await page.evaluate(
      (snapshot) => (window as unknown as StreamWindow).emitFundingSnapshot(snapshot),
      snapshot,
    );
  };
  const focus = async () => {
    const before = state.requests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.requests).toBeGreaterThan(before);
  };
  return { state, funding, base, send, focus };
}

test('Live balances refresh while Overview keeps account funding separate from profit', async ({
  page,
}) => {
  const { state, funding, base, send } = await fixture(page);
  await page.goto('/#live');
  await expect(page.getByTestId('account-available')).toHaveText('0');
  await expect(page.getByTestId('seat-stack')).toHaveText('—');
  await expect(page.getByTestId('rebuy-countdown')).toContainText('remaining');
  await send(state.runtime);
  state.runtime = {
    ...state.runtime,
    funding: funding({
      availableChips: 1500,
      lastRebuyAt: new Date(base + 1).toISOString(),
      rebuyAvailableAt: null,
      updatedAt: new Date(base + 1).toISOString(),
      observedAt: new Date(base + 1).toISOString(),
    }),
  };
  // The still-connected SSE stream contains the old zero balance.
  await expect(page.getByTestId('account-available')).toHaveText('1,500', { timeout: 10_000 });
  await page.getByRole('link', { name: 'Live table', exact: true }).click();
  await expect(page.getByTestId('account-available')).toHaveText('1,500');
  state.runtime = {
    ...state.runtime,
    status: 'playing',
    funding: funding({
      availableChips: 0,
      chipsAtTable: 1500,
      lastRebuyAt: new Date(base + 1).toISOString(),
      rebuyAvailableAt: null,
      updatedAt: new Date(base + 2).toISOString(),
      observedAt: new Date(base + 2).toISOString(),
    }),
    table: {
      tableId: 'funding-table',
      handId: null,
      street: 'idle',
      pot: 0,
      board: [],
      heroCards: [],
      heroSeat: 0,
      dealerSeat: 0,
      stateSeq: 2,
      seats: [{ seat: 0, name: 'Jev', stack: 1500, bet: 0, folded: false, status: 'active' }],
    },
  };
  await send(state.runtime);
  await expect(page.getByTestId('account-available')).toHaveText('0');
  await expect(page.getByTestId('seat-stack')).toHaveText('1,500');
  await expect(page.getByTestId('account-at-table')).toHaveText('1,500');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('account-available')).toHaveCount(0);
  await expect(page.getByTestId('seat-stack')).toHaveCount(0);
  await expect(page.getByTestId('overview-net')).toHaveText('-450');
  await page.getByRole('link', { name: 'Live table', exact: true }).click();
  await expect(page.getByTestId('account-available')).toHaveText('0');
  await expect(page.getByTestId('seat-stack')).toHaveText('1,500');
});

test('loading and stale accounts stay explicit and old funding frames cannot overwrite newer reconciliation', async ({
  page,
}) => {
  const { state, funding, base, send, focus } = await fixture(page);
  state.runtime.funding = funding({
    availableChips: null,
    chipsAtTable: null,
    status: 'loading',
    updatedAt: null,
  });
  await page.goto('/#live');
  await expect(page.getByTestId('account-available')).toHaveText('—');
  await expect(page.getByText('Loading account', { exact: true })).toBeVisible();
  state.runtime.funding = funding({
    availableChips: 1500,
    updatedAt: new Date(base + 10).toISOString(),
    observedAt: new Date(base + 10).toISOString(),
  });
  await focus();
  await expect(page.getByTestId('account-available')).toHaveText('1,500');
  await send({ ...state.runtime, funding: funding() });
  await expect(page.getByTestId('account-available')).toHaveText('1,500');
  const current = structuredClone(state.runtime);
  state.runtime.funding = {
    ...state.runtime.funding,
    status: 'stale',
    observedAt: new Date(base + 20).toISOString(),
  };
  await focus();
  await expect(page.getByText('Account data stale', { exact: true })).toBeVisible();
  // Same successful updatedAt, older observedAt: stale must not become current again.
  await send(current);
  await expect(page.getByText('Account data stale', { exact: true })).toBeVisible();
  await expect(page.getByTestId('account-available')).toHaveText('1,500');
  state.overviewError = true;
  await focus();
  await expect(page.getByText('Account refresh unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Account data stale', { exact: true })).toBeVisible();
  await expect(page.getByTestId('account-available')).toHaveText('1,500');
});

test('funding details fit a mobile viewport and an elapsed cooldown does not invent a rebuy', async ({
  page,
}) => {
  const { state, funding, base } = await fixture(page);
  state.runtime.funding = funding({
    rebuyAvailableAt: new Date(base - 1000).toISOString(),
    updatedAt: new Date(base - 60_000).toISOString(),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#live');
  await expect(page.getByTestId('rebuy-countdown')).toHaveText(
    'Window elapsed · awaiting confirmation',
  );
  await expect(page.getByText('Account data stale', { exact: true })).toBeVisible();
  await expect(page.getByTestId('account-available')).toHaveText('0');
  for (const name of ['Overview', 'Live table']) {
    await page.getByRole('link', { name, exact: true }).click();
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
    await page.screenshot({ path: test.info().outputPath(`funding-${name}.png`), fullPage: true });
  }
});

test('funding history shares one reader across views and separates rebuy observations from reconciliation', async ({
  page,
}) => {
  const { state, base, focus } = await fixture(page);
  const scheduled: FundingEventView = {
    id: 'scheduled',
    runId: 'funding-run',
    createdAt: new Date(base).toISOString(),
    kind: 'rebuy_scheduled',
    source: 'ws',
    amount: 1500,
    availableBefore: null,
    availableAfter: null,
    chipsAtTable: null,
    rebuyAvailableAt: new Date(base + 120_000).toISOString(),
  };
  state.events = [scheduled];
  await page.goto('/#live');
  const history = page.getByRole('region', { name: 'Funding history' });
  await expect(history.getByText('Rebuy scheduled', { exact: true })).toBeVisible();
  await expect(history).toContainText('Account available — → — chips');
  const reads = state.eventRequests;
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(history).toHaveCount(0);
  await page.getByRole('link', { name: 'Live table', exact: true }).click();
  await expect(history.getByText('Rebuy scheduled', { exact: true })).toBeVisible();
  expect(state.eventRequests).toBe(reads);
  state.events = [
    {
      ...scheduled,
      id: 'sync',
      kind: 'balance_sync',
      source: 'reconciliation',
      amount: null,
      availableBefore: 0,
      availableAfter: 1500,
      rebuyAvailableAt: null,
    },
    { ...scheduled, id: 'confirmed', kind: 'rebuy_confirmed', rebuyAvailableAt: null },
    scheduled,
  ];
  await focus();
  await expect(history.getByText('Rebuy confirmation observed', { exact: true })).toBeVisible();
  await expect(history.getByText('Account reconciled', { exact: true })).toBeVisible();
  await expect(history.getByText('Rule amount: 1,500 chips ·', { exact: true })).toHaveCount(1);
  await expect(history).toContainText('Balance reconciliation pending.');
  await expect(history).toContainText('Account available 0 → 1,500 chips');
  state.historyError = true;
  await focus();
  await expect(history).toContainText('Funding history refresh is delayed.');
  await expect(history.getByText('Rebuy confirmation observed', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('older funding records remain accessible after automatic refresh', async ({ page }) => {
  const { state, base, focus } = await fixture(page);
  state.events = Array.from({ length: 12 }, (_, index) => ({
    id: `funding-record-${index}`,
    runId: 'funding-run',
    createdAt: new Date(base - index * 1000).toISOString(),
    kind: 'balance_sync',
    source: 'reconciliation',
    amount: null,
    availableBefore: index,
    availableAfter: index + 1,
    chipsAtTable: null,
    rebuyAvailableAt: null,
  }));
  await page.goto('/#live');
  const history = page.getByRole('region', { name: 'Funding history' });
  await expect(history.locator('li')).toHaveCount(8);
  await history.getByRole('button', { name: 'Load older funding events' }).click();
  await expect(history.locator('li')).toHaveCount(12);
  await expect(history.getByRole('button', { name: 'Load older funding events' })).toHaveCount(0);
  state.events.unshift({
    ...state.events[0]!,
    id: 'new-funding-record',
    createdAt: new Date(base + 1000).toISOString(),
    availableBefore: 30,
    availableAfter: 31,
  });
  await focus();
  await expect(history.locator('li')).toHaveCount(13);
  await expect(history).toContainText('Account available 11 → 12 chips');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(history).toHaveCount(0);
  await page.getByRole('link', { name: 'Live table', exact: true }).click();
  await expect(history.locator('li')).toHaveCount(13);
});
