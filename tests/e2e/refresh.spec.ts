import { mockOverview, mockPerformance } from './dashboard-fixture';
import { expect, test, type Page } from '@playwright/test';
import type {
  DecisionView,
  HandDetail,
  HandSummary,
  Overview,
  RunSummary,
} from '../../src/shared/api';

async function historyFixture(page: Page) {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  const baseHand = original.recentHands[0]!;
  const originalDetail = (await (
    await page.request.get(`/api/hands/${baseHand.id}`)
  ).json()) as HandDetail;
  const run: RunSummary = {
    ...original.runs[0]!,
    id: 'refresh-run',
    hands: 1,
    settledHands: 1,
    excludedHands: 0,
    netChips: 20,
    decisions: 2,
  };
  const otherRun: RunSummary = { ...run, id: 'other-refresh-run' };
  const hand: HandSummary = {
    ...baseHand,
    id: 'refresh-hand',
    runId: run.id,
    handNumber: 1,
    profit: 20,
  };
  const newerHand: HandSummary = {
    ...hand,
    id: 'newer-refresh-hand',
    handNumber: 2,
    startedAt: '2030-01-01T00:00:00Z',
    profit: 60,
  };
  const otherHand: HandSummary = {
    ...hand,
    id: 'other-refresh-hand',
    runId: otherRun.id,
    handNumber: 201,
  };
  const decision = (id: string, target = hand): DecisionView => ({
    ...originalDetail.decisions[0]!,
    id,
    handId: target.id,
    runId: target.runId,
    status: 'accepted',
  });
  const detail: HandDetail = {
    hand,
    events: originalDetail.events,
    decisions: [decision('first-choice'), { ...decision('selected-choice'), status: 'sent' }],
  };
  const otherDetail: HandDetail = {
    hand: otherHand,
    events: originalDetail.events,
    decisions: [decision('other-choice', otherHand)],
  };
  const state = { revision: 0, detailReads: 0 };
  const currentRun = () => ({
    ...run,
    ...(state.revision
      ? { hands: 2, settledHands: 2, netChips: state.revision === 1 ? 80 : 95, decisions: 3 }
      : {}),
  });
  await mockOverview(page, (route) =>
    route.fulfill({
      json: {
        ...original,
        runs: [currentRun(), otherRun],
        recentHands: state.revision ? [newerHand, hand] : [hand],
      },
    }),
  );
  await page.route('**/api/runs?*', (route) => route.fulfill({ json: [currentRun(), otherRun] }));
  await mockPerformance(page, (route) => {
    const current = currentRun();
    return route.fulfill({
      json: {
        runId: current.id,
        settledHands: current.settledHands,
        wonHands: current.settledHands,
        excludedHands: 0,
        netChips: current.netChips,
        winRate: 100,
        score: null,
        scoreObservedAt: null,
        profitPoints: [
          {
            at: hand.startedAt,
            handNumber: current.hands,
            settledHands: current.settledHands,
            netChips: current.netChips,
          },
        ],
        scorePoints: [],
      },
    });
  });
  await page.route('**/api/hands?*', (route) => {
    const runId = new URL(route.request().url()).searchParams.get('runId');
    return route.fulfill({
      json:
        runId === otherRun.id
          ? [otherHand]
          : state.revision
            ? [newerHand, { ...hand, profit: state.revision === 1 ? 20 : 35 }]
            : [hand],
    });
  });
  return { state, run, otherRun, hand, detail, otherDetail, decision };
}

test('new hands, changed metrics and delayed decisions refresh without moving an active replay', async ({
  page,
}) => {
  const fixture = await historyFixture(page);
  await page.route('**/api/hands/*', (route) => {
    fixture.state.detailReads++;
    const updated: HandDetail = fixture.state.revision
      ? {
          ...fixture.detail,
          decisions: [
            fixture.decision('first-choice'),
            fixture.decision('selected-choice'),
            fixture.decision('late-choice'),
          ],
          events: [
            ...fixture.detail.events,
            {
              id: 'late-confirmation',
              type: 'action_ack',
              receivedAt: '2030-01-01T00:00:01Z',
              payload: { status: 'accepted' },
            },
          ],
        }
      : fixture.detail;
    return route.fulfill({ json: updated });
  });
  await page.goto('/');
  const net = page.locator('.metric').filter({ hasText: 'Net result' }).locator('strong');
  await expect(net).toHaveText('+20');
  await page.getByRole('link', { name: 'Replay & decisions' }).click();
  await expect(page.getByRole('heading', { name: 'Hand #001', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next event', exact: true }).click();
  await page.getByLabel('Decision', { exact: true }).selectOption('selected-choice');
  await expect(page.locator('.decision-heading')).toContainText('sent');
  const before = fixture.state.detailReads;
  fixture.state.revision = 1;
  await expect(page.locator('.hand-item')).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByLabel('Decision', { exact: true }).locator('option')).toHaveCount(3, {
    timeout: 10_000,
  });
  expect(fixture.state.detailReads).toBeGreaterThan(before);
  await expect(page.getByRole('heading', { name: 'Hand #001', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Replay event' })).toHaveValue('1');
  await expect(page.getByLabel('Decision', { exact: true })).toHaveValue('selected-choice');
  await expect(page.locator('.decision-heading')).toContainText('accepted');
  // Backfilled settlement data changes without adding another hand.
  fixture.state.revision = 2;
  await expect(page.getByRole('button', { name: /Hand #001/ })).toContainText('+35', {
    timeout: 10_000,
  });
  await expect(page.getByRole('slider', { name: 'Replay event' })).toHaveValue('1');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(net).toHaveText('+95');
  await expect(page.getByText('2 verified · 0 excluded')).toBeVisible();
});

test('a delayed detail refresh cannot overwrite a newly selected run', async ({ page }) => {
  const fixture = await historyFixture(page);
  let releaseOld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldRequested = false;
  await page.route('**/api/hands/*', async (route) => {
    const handId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    if (handId === fixture.otherDetail.hand.id) {
      await route.fulfill({ json: fixture.otherDetail });
      return;
    }
    fixture.state.detailReads++;
    if (fixture.state.detailReads > 1) {
      oldRequested = true;
      await held;
    }
    await route.fulfill({ json: fixture.detail });
  });
  try {
    await page.goto('/#replay');
    await expect(page.getByRole('heading', { name: 'Hand #001', exact: true })).toBeVisible();
    await expect.poll(() => oldRequested, { timeout: 10_000 }).toBe(true);
    const cancelled = page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().endsWith(`/api/hands/${fixture.hand.id}`),
    });
    await page.getByLabel('Selected run').selectOption(fixture.otherRun.id);
    await expect(page.getByRole('heading', { name: 'Hand #201', exact: true })).toBeVisible();
    releaseOld();
    await cancelled;
    await expect(page.getByLabel('Selected run')).toHaveValue(fixture.otherRun.id);
    await expect(page.getByRole('heading', { name: 'Hand #201', exact: true })).toBeVisible();
    await expect(page.getByLabel('Decision', { exact: true })).toHaveValue('other-choice');
    await expect(page.getByRole('slider', { name: 'Replay event' })).toHaveValue('0');
    await expect(page.getByRole('heading', { name: 'Hand #001', exact: true })).toHaveCount(0);
  } finally {
    releaseOld();
  }
});
