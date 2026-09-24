import { expect, test } from '@playwright/test';
import type { Overview, RuntimeView } from '../../src/shared/api';
import { mockOverview } from './dashboard-fixture';

test('a stopped unseated bot explains its pause in Overview and Live, then clears after recovery', async ({
  page,
}) => {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const runtime: RuntimeView = {
    ...original.runtime,
    running: false,
    status: 'stopped',
    mode: 'live',
    table: null,
    decision: null,
    error: 'Bot paused: the decision state changed before submission.',
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(request.url());
  });
  await page.route('**/api/live', (route) => route.abort());
  await mockOverview(page, (route) => route.fulfill({ json: { ...original, runtime } }));
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({ json: { session: null, decisions: [] } }),
  );
  await page.goto('/#overview');
  const notice = page.getByRole('alert').filter({ hasText: runtime.error! });
  await expect(notice).toBeVisible();
  await page.getByRole('link', { name: 'Live table', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The agent’s table.' })).toBeVisible();
  await expect(notice).toBeVisible();
  await expect(page.getByRole('button', { name: /resume|start bot|stop bot/i })).toHaveCount(0);
  runtime.running = true;
  runtime.status = 'queued';
  runtime.error = null;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(notice).toHaveCount(0);
  expect(writes).toEqual([]);
});
