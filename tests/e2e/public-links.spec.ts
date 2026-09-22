import { expect, test, type Page } from '@playwright/test';
import type { Overview, RuntimeView } from '../../src/shared/api';

async function fixture(page: Page) {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const runtime: RuntimeView = {
    ...original.runtime,
    mode: 'live',
    running: true,
    status: 'playing',
    table: {
      tableId: 'table-first',
      handId: null,
      street: 'idle',
      pot: 0,
      board: [],
      heroCards: [],
      heroSeat: 0,
      dealerSeat: 1,
      stateSeq: 1,
      seats: [],
    },
  };
  const state = { runtime, reads: 0 };
  await page.route('**/api/live', (route) => route.abort());
  await page.route('**/api/overview', (route) => {
    state.reads++;
    return route.fulfill({ json: { ...original, runtime: state.runtime } });
  });
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({ json: { session: null, decisions: [] } }),
  );
  const focus = async () => {
    const reads = state.reads;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.reads).toBeGreaterThan(reads);
  };
  return { state, focus };
}

test('official arena link follows the current playing table and hides for stopped, absent or demo tables', async ({
  page,
}) => {
  const { state, focus } = await fixture(page);
  await page.goto('/#live');
  const link = page.getByRole('link', { name: 'Watch on OpenPoker', exact: true });
  await expect(link).toHaveAttribute('href', 'https://openpoker.ai/arena/table-first');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  state.runtime.table = { ...state.runtime.table!, tableId: 'table-next', stateSeq: 2 };
  await focus();
  await expect(link).toHaveAttribute('href', 'https://openpoker.ai/arena/table-next');
  state.runtime = { ...state.runtime, running: false, status: 'stopped' };
  await focus();
  await expect(link).toHaveCount(0);
  state.runtime = { ...state.runtime, running: true, status: 'playing', table: null };
  await focus();
  await expect(link).toHaveCount(0);
  state.runtime = {
    ...state.runtime,
    mode: 'demo',
    table: {
      tableId: 'synthetic-table',
      handId: null,
      street: 'idle',
      pot: 0,
      board: [],
      heroCards: [],
      heroSeat: null,
      dealerSeat: null,
      seats: [],
    },
  };
  await focus();
  await expect(link).toHaveCount(0);
});

test('GitHub opens the repository safely and both public links fit desktop and mobile with the run selector', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/#live');
  const github = page.getByRole('link', { name: 'GitHub', exact: true });
  await expect(github).toHaveAttribute('href', 'https://github.com/hewenyu/jev-card-agent');
  await expect(github).toHaveAttribute('target', '_blank');
  await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(github).toBeVisible();
    const select = page.getByLabel('Selected run');
    await expect(select).toBeVisible();
    await expect(page.getByRole('link', { name: 'Watch on OpenPoker', exact: true })).toBeVisible();
    const githubBox = (await github.boundingBox())!;
    const selectorBox = (await select.boundingBox())!;
    const separated =
      githubBox.x >= selectorBox.x + selectorBox.width ||
      selectorBox.x >= githubBox.x + githubBox.width ||
      githubBox.y >= selectorBox.y + selectorBox.height ||
      selectorBox.y >= githubBox.y + githubBox.height;
    expect(separated).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: test.info().outputPath(`public-links-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(github).toBeVisible();
  await expect(page.getByRole('link', { name: 'Watch on OpenPoker', exact: true })).toHaveCount(0);
});
