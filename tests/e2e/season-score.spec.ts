import { expect, test, type Page } from '@playwright/test';
import type {
  FundingView,
  Overview,
  PerformanceView,
  RunSummary,
  RuntimeView,
} from '../../src/shared/api';

async function fixture(page: Page) {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const now = Date.now();
  const makeRun = (id: string, order: number): RunSummary => ({
    ...original.runs[0]!,
    id,
    mode: 'live',
    strategy: 'jev',
    status: 'playing',
    fallbackCount: 0,
    startedAt: new Date(now - 100000 + order * 1000).toISOString(),
  });
  const current = makeRun('score-current-a', 1);
  const old = makeRun('score-history-old', 0);
  const funding: FundingView = {
    availableChips: 500,
    chipsAtTable: 1500,
    seasonScore: 4321,
    seasonId: 'season-new',
    status: 'current',
    updatedAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    autoRebuy: true,
    rebuyAmount: 1500,
    rebuyCooldownSeconds: 300,
    rebuyAvailableAt: null,
    lastRebuyAt: null,
  };
  const runtime: RuntimeView = {
    ...original.runtime,
    mode: 'live',
    running: true,
    status: 'playing',
    runId: current.id,
    strategy: 'jev',
    funding,
    table: {
      tableId: 'score-table',
      handId: 'score-hand',
      street: 'flop',
      pot: 200,
      heroCards: ['Ah', 'Kd'],
      board: ['2c', '3h', '4s'],
      heroSeat: 0,
      dealerSeat: 1,
      stateSeq: 1,
      seats: [{ seat: 0, name: 'Jev', stack: 1400, bet: 100, folded: false, status: 'active' }],
    },
  };
  const performance = (runId: string): PerformanceView => ({
    runId,
    settledHands: 3,
    wonHands: 1,
    excludedHands: 0,
    netChips: -20,
    winRate: 100 / 3,
    score: runId === old.id ? 250 : 0,
    scoreSource: 'official',
    seasonId: 'season-new',
    scoreObservedAt: new Date(now - 10000).toISOString(),
    profitPoints: [],
    scorePoints: [{ at: new Date(now - 10000).toISOString(), score: runId === old.id ? 250 : 0 }],
  });
  const state = {
    runtime,
    runs: [current, old],
    reads: 0,
    performanceFailed: false,
    performanceOverride: null as PerformanceView | null,
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(request.method());
  });
  await page.route('**/api/live', (route) => route.abort());
  await page.route('**/api/overview', (route) => {
    state.reads++;
    return route.fulfill({
      json: { ...original, runtime: state.runtime, runs: state.runs, recentHands: [] },
    });
  });
  await page.route('**/api/runs?*', (route) => route.fulfill({ json: state.runs }));
  await page.route('**/api/hands?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({ json: { session: null, decisions: [] } }),
  );
  await page.route('**/api/funding/events*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/runs/*/performance', (route) => {
    const runId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    return state.performanceFailed
      ? route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } })
      : route.fulfill({
          json:
            state.performanceOverride?.runId === runId
              ? state.performanceOverride
              : performance(runId),
        });
  });
  const focus = async () => {
    const before = state.reads;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.reads).toBeGreaterThan(before);
  };
  return { state, now, current, old, makeRun, performance, focus, writes };
}

test('current Overview and Live share official score through departure, stale restoration and missing statistics', async ({
  page,
}) => {
  const { state, focus, now, writes } = await fixture(page);
  state.performanceFailed = true;
  await page.goto('/');
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
  await expect(page.getByText('Statistics refresh is delayed.')).toBeVisible();
  await expect(page.getByTestId('overview-score-status')).toHaveText(
    'Current official account score',
  );
  await page.getByRole('button', { name: 'Season score', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Season score: 4,321 chips' })).toBeVisible();
  await page.getByRole('link', { name: 'Live table', exact: true }).click();
  await expect(page.getByTestId('live-season-score')).toHaveText('4,321');
  await expect(page.getByTestId('account-available')).toHaveText('500');
  await expect(page.getByTestId('account-at-table')).toHaveText('1,500');
  await page
    .getByRole('region', { name: 'Official season score' })
    .screenshot({ path: 'test-results/season-score-live.png' });
  state.runtime = {
    ...state.runtime,
    running: false,
    status: 'stopped',
    table: null,
    funding: {
      ...state.runtime.funding!,
      availableChips: 2000,
      chipsAtTable: 0,
      updatedAt: new Date(now + 1000).toISOString(),
      observedAt: new Date(now + 1000).toISOString(),
    },
  };
  await focus();
  await expect(page.getByTestId('account-available')).toHaveText('2,000');
  await expect(page.getByTestId('seat-stack')).toHaveText('—');
  await expect(page.getByTestId('live-season-score')).toHaveText('4,321');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
  state.runtime.funding = {
    ...state.runtime.funding!,
    status: 'stale',
    observedAt: new Date(now + 2000).toISOString(),
  };
  await focus();
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
  await expect(page.getByTestId('overview-score-status')).toContainText(
    'Last confirmed official score',
  );
  state.runtime.funding = {
    ...state.runtime.funding!,
    seasonScore: -125,
    status: 'current',
    updatedAt: new Date(now + 2500).toISOString(),
    observedAt: new Date(now + 2500).toISOString(),
  };
  await focus();
  await expect(page.getByTestId('overview-score')).toHaveText('-125');
  await page.getByRole('link', { name: 'Live table', exact: true }).click();
  await expect(page.getByTestId('live-season-score')).toHaveText('-125');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  state.runtime.funding = {
    ...state.runtime.funding!,
    seasonScore: null,
    status: 'loading',
    updatedAt: null,
    observedAt: new Date(now + 3000).toISOString(),
  };
  await focus();
  await expect(page.getByTestId('overview-score')).toHaveText('—');
  await expect(page.getByTestId('overview-score-status')).toHaveText(
    'Official score not yet reported',
  );
  expect(writes).toEqual([]);
});

test('new runs follow automatically without zeroing score and an explicit historical choice stays selected', async ({
  page,
}) => {
  const { state, current, old, makeRun, focus } = await fixture(page);
  await page.goto('/');
  await expect(page.getByLabel('Selected run')).toHaveValue(current.id);
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
  await page.screenshot({ path: 'test-results/season-score-overview.png', fullPage: true });
  const next = makeRun('score-current-b', 2);
  state.runs.unshift(next);
  state.runtime = {
    ...state.runtime,
    runId: next.id,
    funding: { ...state.runtime.funding!, status: 'stale' },
  };
  await focus();
  await expect(page.getByLabel('Selected run')).toHaveValue(next.id);
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
  await page.getByLabel('Selected run').selectOption(old.id);
  await expect(page.getByTestId('overview-score')).toHaveText('250');
  await expect(
    page.getByText('Selected historical run · recorded results and score'),
  ).toBeVisible();
  const third = makeRun('score-current-c', 3);
  state.runs.unshift(third);
  state.runtime = { ...state.runtime, runId: third.id };
  await focus();
  await expect(page.getByLabel('Selected run')).toHaveValue(old.id);
  await expect(page.getByTestId('overview-score')).toHaveText('250');
  await page.getByLabel('Selected run').selectOption(third.id);
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
  const fourth = makeRun('score-current-d', 4);
  state.runs.unshift(fourth);
  state.runtime = { ...state.runtime, runId: fourth.id };
  await focus();
  await expect(page.getByLabel('Selected run')).toHaveValue(fourth.id);
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
});

test('legacy history remains labelled as a balance estimate while current score is official', async ({
  page,
}) => {
  const { state, old, performance } = await fixture(page);
  state.performanceOverride = {
    ...performance(old.id),
    score: 2000,
    scoreSource: 'legacy_balance_sum',
    seasonId: null,
    scorePoints: [{ at: new Date().toISOString(), score: 2000 }],
  };
  await page.goto('/');
  await expect(page.getByTestId('overview-score')).toHaveText('4,321');
  await page.getByLabel('Selected run').selectOption(old.id);
  await expect(page.getByTestId('overview-score')).toHaveText('2,000');
  await expect(page.getByTestId('overview-score-status')).toHaveText(
    'Legacy account + table balance · not official score',
  );
  await page.getByRole('button', { name: 'Historical estimate', exact: true }).click();
  await expect(
    page.getByRole('img', { name: 'Historical balance estimate: 2,000 chips' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('current score chart does not join an earlier season or duplicate the latest official point', async ({
  page,
}) => {
  const { state, current, now, performance, focus } = await fixture(page);
  state.performanceOverride = {
    ...performance(current.id),
    seasonId: 'season-old',
    score: 9999,
    scorePoints: [{ at: new Date(now - 1000).toISOString(), score: 9999 }],
  };
  await page.goto('/');
  await page.getByRole('button', { name: 'Season score', exact: true }).click();
  const chart = page.getByRole('img', { name: 'Season score: 4,321 chips' });
  await expect(chart).toBeVisible();
  await expect(chart.locator('circle')).toHaveCount(1);
  state.performanceOverride = {
    ...state.performanceOverride,
    seasonId: 'season-new',
    score: 4321,
    scorePoints: [
      { at: new Date(now - 1000).toISOString(), score: 4200 },
      { at: state.runtime.funding!.updatedAt!, score: 4321 },
      // A later statistics response cannot change the score displayed from the current Live observation.
      { at: new Date(now + 1000).toISOString(), score: 9999 },
    ],
  };
  await focus();
  await expect(chart.locator('circle')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
