import { mockOverview } from './dashboard-fixture';
import { expect, test, type Page } from '@playwright/test';
import type { HandDetail, Overview } from '../../src/shared/api';

async function liveWithAnalysis(page: Page) {
  const overview = (await (await page.request.get('/api/overview')).json()) as Overview;
  const hand = overview.recentHands[0]!;
  const detail = (await (await page.request.get(`/api/hands/${hand.id}`)).json()) as HandDetail;
  const decision = {
    ...detail.decisions[0]!,
    routing: {
      outcome: 'reasoned_jev_final',
      reasoningMode: 'always',
      requestedModel: 'deepseek-flash',
      actualModel: 'deepseek-flash',
      thinkingMode: 'disabled',
      analysis:
        'Consider position, the current pot odds, and the observed opponent sample. '.repeat(12),
    },
  };
  await page.route('**/api/live', (route) => route.abort());
  await mockOverview(page, (route) =>
    route.fulfill({
      json: {
        ...overview,
        runtime: {
          ...overview.runtime,
          runId: decision.runId,
          table: {
            tableId: hand.tableId,
            handId: hand.id,
            street: 'flop',
            board: ['2h', '3d', '4s'],
            pot: 120,
            heroSeat: 0,
            heroCards: ['Ah', 'Kd'],
            dealerSeat: 1,
            actorSeat: 0,
            seats: Array.from({ length: 6 }, (_, seat) => ({
              seat,
              name: seat === 0 ? 'Jev agent' : `Opponent ${seat}`,
              stack: 1900 + seat * 20,
              bet: 20,
              folded: false,
              status: 'active',
            })),
          },
        },
      },
    }),
  );
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({
      json: {
        session: {
          id: 'layout-session',
          tableId: hand.tableId,
          handId: hand.id,
          runId: decision.runId,
          turnCount: 1,
        },
        decisions: [decision],
      },
    }),
  );
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Live puts the table before supporting information at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await liveWithAnalysis(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('The agent’s table.');
    await expect(page.locator('.brand')).toHaveAttribute('href', '#overview');
    await page.getByRole('link', { name: 'Live table', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'The agent’s table.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Provider recommendation' })).toBeVisible();
    const table = (await page.locator('.spectator-layout > .panel').boundingBox())!;
    const decisions = (await page
      .getByRole('complementary', { name: 'Live decisions' })
      .boundingBox())!;
    const funding = (await page.locator('.account-funding').boundingBox())!;
    expect(table.y).toBeLessThan(300);
    expect(table.y + table.height).toBeLessThan(viewport.height);
    if (viewport.width > 1000) {
      expect(decisions.x).toBeGreaterThanOrEqual(table.x + table.width);
      expect(Math.abs(decisions.y - table.y)).toBeLessThan(2);
    } else {
      expect(decisions.y).toBeGreaterThanOrEqual(table.y + table.height);
    }
    expect(funding.y).toBeGreaterThanOrEqual(
      Math.max(table.y + table.height, decisions.y + decisions.height),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({ path: test.info().outputPath(`live-${viewport.width}.png`) });
    await page.screenshot({
      path: test.info().outputPath(`live-${viewport.width}-full.png`),
      fullPage: true,
    });
  });
}
