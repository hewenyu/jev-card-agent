import { expect, test, type Page } from '@playwright/test';
import type { Overview, PerformanceView } from '../../src/shared/api';

const start = '2026-09-20T12:00:00.000Z';
const end = '2026-09-20T12:30:00.000Z';

function performance(runId: string, changes: Partial<PerformanceView> = {}): PerformanceView {
  return {
    runId,
    settledHands: 240,
    wonHands: 96,
    excludedHands: 3,
    netChips: 1250,
    winRate: 40,
    score: 870,
    scoreObservedAt: end,
    profitPoints: [
      { at: start, handNumber: 1, settledHands: 1, netChips: -50 },
      { at: end, handNumber: 243, settledHands: 240, netChips: 1250 },
    ],
    scorePoints: [
      { at: start, score: 1000 },
      { at: end, score: 870 },
    ],
    ...changes,
  };
}

async function fixture(page: Page) {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const runId = 'overview-statistics-run';
  const otherRunId = 'overview-other-run';
  const runs = [runId, otherRunId].map((id) => ({
    ...original.runs[0]!,
    id,
    mode: 'live',
    startedAt: start,
  }));
  const state = { value: performance(runId), reads: 0, failed: false };
  await page.route('**/api/live', (route) => route.abort());
  await page.route('**/api/overview', (route) =>
    route.fulfill({ json: { ...original, runs, recentHands: [] } }),
  );
  await page.route('**/api/runs?*', (route) => route.fulfill({ json: runs }));
  // No loaded hand page is needed to compute the complete-run statistics or curves.
  await page.route('**/api/hands?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/runs/*/performance', (route) => {
    state.reads++;
    return state.failed
      ? route.fulfill({ status: 503, json: { error: 'Temporary statistics failure' } })
      : route.fulfill({ json: state.value });
  });
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  return { state, runId, otherRunId, focus };
}

test('Overview shows only complete-run outcome statistics and independent score/profit curves', async ({
  page,
}) => {
  const { state, runId, focus } = await fixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Results at a glance.' })).toBeVisible();
  await expect(page.locator('.metric')).toHaveCount(3);
  await expect(page.getByTestId('overview-net')).toHaveText('+1,250');
  await expect(page.getByTestId('overview-win-rate')).toHaveText('40%');
  await expect(page.getByTestId('overview-score')).toHaveText('870');
  await expect(page.getByText('240 verified · 3 excluded')).toBeVisible();
  await expect(page.getByRole('img', { name: /Cumulative net profit.*1,250/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Net profit', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (const name of ['Agent profile', 'Recent hands', 'Funding history', 'Decision trace']) {
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('region', { name: 'Funding history' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Replay hand/ })).toHaveCount(0);
  await expect(page.getByTestId('account-available')).toHaveCount(0);
  await expect(page.locator('.metric').filter({ hasText: /Decisions|Model cost/ })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Season score', exact: true }).click();
  await expect(page.getByRole('img', { name: /Season score.*870/ })).toBeVisible();
  // A later authoritative score snapshot can change independently of settled profit (e.g. rebuy).
  state.value = performance(runId, {
    score: 2370,
    scorePoints: [...state.value.scorePoints, { at: '2026-09-20T12:31:00.000Z', score: 2370 }],
  });
  await focus();
  await expect(page.getByTestId('overview-score')).toHaveText('2,370');
  await expect(page.getByRole('img', { name: /Season score.*2,370/ })).toBeVisible();
  await expect(page.getByTestId('overview-net')).toHaveText('+1,250');
  await expect(page.getByTestId('overview-win-rate')).toHaveText('40%');
  await page.getByRole('button', { name: 'Net profit', exact: true }).click();
  await expect(page.getByRole('img', { name: /Cumulative net profit.*1,250/ })).toBeVisible();
});

test('statistics refresh automatically, preserve same-run data on failure, and recover on focus', async ({
  page,
}) => {
  const { state, runId, focus } = await fixture(page);
  await page.goto('/');
  await expect(page.getByTestId('overview-net')).toHaveText('+1,250');
  const reads = state.reads;
  state.value = performance(runId, {
    netChips: 1300,
    profitPoints: [{ at: end, handNumber: 243, settledHands: 240, netChips: 1300 }],
  });
  await expect(page.getByTestId('overview-net')).toHaveText('+1,300', { timeout: 10_000 });
  expect(state.reads).toBeGreaterThan(reads);
  state.failed = true;
  await focus();
  await expect(page.getByText('Statistics refresh is delayed.')).toBeVisible();
  await expect(page.getByTestId('overview-net')).toHaveText('+1,300');
  await expect(page.getByRole('img', { name: /Cumulative net profit.*1,300/ })).toBeVisible();
  state.failed = false;
  state.value = performance(runId);
  await focus();
  await expect(page.getByTestId('overview-net')).toHaveText('+1,250');
  await expect(page.getByText('Statistics refresh is delayed.')).toHaveCount(0);
});

test('late statistics from an old run cannot replace the newly selected run', async ({ page }) => {
  const { runId, otherRunId, focus } = await fixture(page);
  let releaseOld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let releaseNew!: () => void;
  const newHeld = new Promise<void>((resolve) => {
    releaseNew = resolve;
  });
  let oldReads = 0;
  let oldRequested = false;
  let newRequested = false;
  await page.route('**/api/runs/*/performance', async (route) => {
    const selectedId = decodeURIComponent(
      new URL(route.request().url()).pathname.split('/').at(-2)!,
    );
    if (selectedId === otherRunId) {
      newRequested = true;
      await newHeld;
      await route.fulfill({
        json: performance(otherRunId, {
          netChips: -200,
          winRate: 0,
          wonHands: 0,
          profitPoints: [{ at: end, handNumber: 1, settledHands: 1, netChips: -200 }],
        }),
      });
      return;
    }
    if (++oldReads > 1) {
      oldRequested = true;
      await held;
    }
    await route.fulfill({ json: performance(runId) });
  });
  try {
    await page.goto('/');
    await expect(page.getByTestId('overview-net')).toHaveText('+1,250');
    await focus();
    await expect.poll(() => oldRequested).toBe(true);
    await page.getByLabel('Selected run').selectOption(otherRunId);
    await expect.poll(() => newRequested).toBe(true);
    await expect(page.getByTestId('overview-net')).toHaveText('—');
    await expect(page.getByRole('img', { name: /Cumulative net profit/ })).toHaveCount(0);
    releaseNew();
    await expect(page.getByTestId('overview-net')).toHaveText('-200');
    const returned = page.waitForResponse((response) =>
      response.url().endsWith(`/api/runs/${runId}/performance`),
    );
    releaseOld();
    await returned;
    await expect(page.getByLabel('Selected run')).toHaveValue(otherRunId);
    await expect(page.getByTestId('overview-net')).toHaveText('-200');
    await expect(page.getByTestId('overview-win-rate')).toHaveText('0%');
    await expect(page.getByRole('img', { name: /Cumulative net profit.*-200/ })).toBeVisible();
  } finally {
    releaseOld();
    releaseNew();
  }
});

test('no verified samples or score snapshots are shown as unavailable rather than zero', async ({
  page,
}) => {
  const { state, runId } = await fixture(page);
  state.value = performance(runId, {
    settledHands: 0,
    wonHands: 0,
    excludedHands: 2,
    netChips: 0,
    winRate: null,
    score: null,
    scoreObservedAt: null,
    profitPoints: [],
    scorePoints: [],
  });
  await page.goto('/');
  for (const metric of ['overview-net', 'overview-win-rate', 'overview-score']) {
    await expect(page.getByTestId(metric)).toHaveText('—');
  }
  await expect(page.getByText('0 verified · 2 excluded')).toBeVisible();
  await expect(page.getByRole('img', { name: /Cumulative net profit/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Season score', exact: true }).click();
  await expect(page.getByRole('img', { name: /Season score/ })).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`Overview statistics and charts remain readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto('/');
    await expect(page.getByTestId('overview-net')).toHaveText('+1,250');
    const chart = page.getByRole('img', { name: /Cumulative net profit/ });
    await expect(chart).toBeVisible();
    const box = (await chart.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: test.info().outputPath(`overview-${width}.png`),
      fullPage: true,
    });
  });
}
