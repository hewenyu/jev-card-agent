import { expect, test } from '@playwright/test';
import type { HandDetail, HandSummary, Overview, RunSummary } from '../../src/shared/api';

test('public completed history pages to older hands and runs with retry and isolated run selection', async ({
  page,
}) => {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const template = original.runs[0]!;
  const handTemplate = original.recentHands[0]!;
  const runs: RunSummary[] = Array.from({ length: 101 }, (_, index) => ({
    ...template,
    id: `archive-run-${String(index).padStart(3, '0')}`,
    mode: 'live',
    status: 'stopped',
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 200 - index)).toISOString(),
    endedAt: '2026-01-02T00:00:00.000Z',
    hands: index === 0 ? 101 : 1,
  }));
  const makeHand = (index: number, runId = runs[0]!.id): HandSummary => ({
    ...handTemplate,
    id: `${runId}-hand-${index}`,
    runId,
    handNumber: 101 - index,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 200 - index)).toISOString(),
    status: 'complete',
    endedAt: '2026-01-02T00:00:00.000Z',
  });
  const firstPage = Array.from({ length: 100 }, (_, index) => makeHand(index));
  const laterHistory = Array.from({ length: 211 }, (_, index) => makeHand(index - 110));
  const oldestHand = makeHand(100);
  const olderRunHand = makeHand(100, runs[100]!.id);
  const requestedHands: string[] = [];
  let failOlderPage = true;
  let olderRequests = 0;
  let overviewReads = 0;
  let revealNewHands = false;
  await page.route('**/api/overview', (route) => {
    overviewReads++;
    return route.fulfill({
      json: {
        ...original,
        runs: runs
          .slice(0, 100)
          .map((run, index) => (index === 0 && revealNewHands ? { ...run, hands: 211 } : run)),
        recentHands: firstPage.slice(0, 5),
        runtime: { ...original.runtime, running: false, runId: null, table: null },
        capabilities: { ...original.capabilities, canControl: false },
      },
    });
  });
  await page.route('**/api/runs?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('limit')).toBe('100');
    const before = query.get('before');
    if (before) expect(before).toBe(runs[99]!.id);
    return route.fulfill({ json: before ? [runs[100]] : runs.slice(0, 100) });
  });
  await page.route('**/api/hands?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('limit')).toBe('100');
    const before = query.get('before');
    if (query.get('runId') === runs[100]!.id) return route.fulfill({ json: [olderRunHand] });
    expect(query.get('runId')).toBe(runs[0]!.id);
    if (revealNewHands) {
      const start = before ? laterHistory.findIndex((hand) => hand.id === before) + 1 : 0;
      expect(start).toBeGreaterThanOrEqual(0);
      return route.fulfill({ json: laterHistory.slice(start, start + 100) });
    }
    if (!before) return route.fulfill({ json: firstPage });
    expect(before).toBe(firstPage[99]!.id);
    olderRequests++;
    if (failOlderPage) {
      failOlderPage = false;
      return route.fulfill({ status: 503, json: { error: 'History temporarily unavailable' } });
    }
    return route.fulfill({ json: [firstPage[99], oldestHand] });
  });
  await page.route('**/api/hands/*', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    requestedHands.push(id);
    const hand = [...laterHistory, olderRunHand].find((item) => item.id === id);
    expect(hand?.status).toBe('complete');
    const detail: HandDetail = { hand: hand!, decisions: [], events: [] };
    return route.fulfill({ json: detail });
  });

  await page.goto('/#replay');
  await expect(page.locator('.hand-item')).toHaveCount(100);
  expect(olderRequests).toBe(0);
  await page.getByRole('button', { name: 'Load older hands' }).click();
  await expect(page.getByRole('alert')).toContainText('History temporarily unavailable');
  await page.getByRole('button', { name: 'Retry hand history' }).click();
  await expect(page.locator('.hand-item')).toHaveCount(101);
  await expect(page.getByText('All recorded hands loaded.')).toBeVisible();
  await page.getByRole('button', { name: /Hand #001/ }).click();
  await expect(page.getByRole('heading', { name: 'Hand #001', exact: true })).toBeVisible();
  expect(requestedHands).toContain(oldestHand.id);

  // A background tab may miss more than one page; pagination must fill that gap.
  revealNewHands = true;
  await expect(page.locator('.hand-item')).toHaveCount(201);
  await page.getByRole('button', { name: 'Load older hands' }).click();
  await expect(page.locator('.hand-item')).toHaveCount(211);
  await page.getByRole('button', { name: 'Load older hands' }).click();
  await expect(page.getByText('All recorded hands loaded.')).toBeVisible();
  await page.getByRole('button', { name: /Hand #102/ }).click();
  await expect(page.getByRole('heading', { name: 'Hand #102', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Load older runs' }).click();
  await expect(page.getByLabel('Selected run').locator('option')).toHaveCount(101);
  await page.getByLabel('Selected run').selectOption(runs[100]!.id);
  await expect(page.locator('.hand-item')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Hand #001', exact: true })).toBeVisible();
  expect(requestedHands).toContain(olderRunHand.id);
  const pollCount = overviewReads;
  await expect.poll(() => overviewReads).toBeGreaterThan(pollCount);
  await expect(page.getByLabel('Selected run')).toHaveValue(runs[100]!.id);
  await expect(page.locator('.hand-item')).toHaveCount(1);
  await page.getByRole('link', { name: 'Live table' }).click();
  await expect(page.getByRole('button', { name: 'Start live run', exact: true })).toBeDisabled();
});

test('changing runs ignores an old response and removing access clears private history', async ({
  page,
}) => {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const privateRun = { ...original.runs[0]!, id: 'private-active-run', status: 'running' };
  const publicRun = { ...original.runs[0]!, id: 'public-ended-run', status: 'stopped' };
  const privateHand = {
    ...original.recentHands[0]!,
    id: 'private-active-hand',
    runId: privateRun.id,
    handNumber: 999,
    status: 'active',
  };
  const publicHand = {
    ...original.recentHands[0]!,
    id: 'public-ended-hand',
    runId: publicRun.id,
    handNumber: 1,
    status: 'complete',
  };
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('history-test-initialized')) {
      sessionStorage.setItem('history-test-initialized', 'true');
      sessionStorage.setItem('jev.console.token', 'test-access-token');
    }
  });
  await page.route('**/api/overview', (route) => {
    const authenticated = !!route.request().headers().authorization;
    return route.fulfill({
      json: {
        ...original,
        runs: authenticated ? [privateRun, publicRun] : [publicRun],
        recentHands: authenticated ? [privateHand, publicHand] : [publicHand],
        capabilities: { ...original.capabilities, canControl: authenticated },
        runtime: { ...original.runtime, running: false, table: null },
      },
    });
  });
  await page.route('**/api/runs?*', (route) =>
    route.fulfill({
      json: route.request().headers().authorization ? [privateRun, publicRun] : [publicRun],
    }),
  );
  let releasePrivate!: () => void;
  const pendingPrivate = new Promise<void>((resolve) => {
    releasePrivate = resolve;
  });
  let privateRequested = false;
  await page.route('**/api/hands?*', async (route) => {
    const runId = new URL(route.request().url()).searchParams.get('runId');
    if (runId === privateRun.id) {
      privateRequested = true;
      await pendingPrivate;
      await route.fulfill({ json: [privateHand] });
    } else {
      await route.fulfill({ json: [publicHand] });
    }
  });
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { hand: publicHand, events: [], decisions: [] } }),
  );
  await page.goto('/#replay');
  await expect.poll(() => privateRequested).toBe(true);
  await page.getByLabel('Selected run').selectOption(publicRun.id);
  await expect(page.locator('.hand-item')).toHaveCount(1);
  const previousFinished = page.waitForResponse((response) =>
    response.url().includes(`runId=${privateRun.id}`),
  );
  releasePrivate();
  await previousFinished;
  await expect(page.locator('.hand-item')).toHaveCount(1);
  await expect(page.locator('.hand-item')).toContainText('Hand #001');
  await expect(page.getByText('Hand #999')).toHaveCount(0);
  await page.getByRole('button', { name: /Access settings/ }).click();
  await page.getByLabel('Console access token', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save access settings' }).click();
  await expect(page.getByLabel('Selected run').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Selected run')).toHaveValue(publicRun.id);
  await expect(page.locator('option[value="private-active-run"]')).toHaveCount(0);
  await expect(page.locator('.hand-item')).toHaveCount(1);
  expect(await page.evaluate(() => sessionStorage.getItem('jev.console.token'))).toBeNull();
});
