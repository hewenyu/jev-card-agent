import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/hands/*', async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({
      json: {
        ...detail,
        decisions: detail.decisions.map((decision: { context: Record<string, unknown> }) => ({
          ...decision,
          context: {
            ...decision.context,
            handId: '11111111-2222-4333-8444-555555555555',
            recentOutcomes: Array.from({ length: 10 }, (_, index) => ({
              runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              handId: `00000000-1111-4222-8333-${String(index).padStart(12, '0')}`,
              strategy: 'jev-reasoning',
              decisions: [{ decisionId: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb' }],
              profitBb: -1.5,
            })),
          },
        })),
      },
    });
  });
});

test('mobile overview keeps statistics and its curve within the viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Results at a glance.' })).toBeVisible();
  await expect(page.locator('.metric')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Net profit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Replay hand/ })).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  await page.getByRole('link', { name: 'Replay & decisions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
});

test('expanded real-length IDs and historical contexts scroll within a mobile replay panel', async ({
  page,
}) => {
  await page.goto('/#replay');
  await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
  await page.getByText('Inspect decision context', { exact: true }).click();
  await expect(page.locator('.context-details pre')).toContainText(
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  );
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    context: document.querySelector('.context-details pre')!.scrollWidth,
    panel: document.querySelector('.context-details pre')!.clientWidth,
  }));
  expect(dimensions.context).toBeGreaterThan(dimensions.panel);
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
});
