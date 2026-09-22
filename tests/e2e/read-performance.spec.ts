import { expect, test } from '@playwright/test';
import type { HandDetail, Overview } from '../../src/shared/api';

test('one dashboard supplies Overview and inactive views do not fetch hand or funding history', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search);
  });
  await page.goto('/');
  await expect(page.getByTestId('overview-net')).not.toHaveText('—');
  expect(requests.filter((path) => path.startsWith('/api/dashboard?'))).toHaveLength(1);
  expect(requests.filter((path) => /\/api\/(overview|runs|hands|funding)/.test(path))).toEqual([]);
  await page.getByRole('link', { name: 'Live table' }).click();
  await expect(page.getByRole('heading', { name: 'The agent’s table.' })).toBeVisible();
  await expect
    .poll(() => requests.some((path) => path.includes('/dashboard?view=live')))
    .toBe(true);
  const before = requests.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  expect(requests.filter((path) => /\/api\/(runs|hands)/.test(path))).toEqual([]);
  expect(requests.some((path) => path.startsWith('/api/funding/events'))).toBe(true);
  await page.getByRole('link', { name: 'Replay & decisions' }).click();
  await expect(page.locator('.hand-item').first()).toBeVisible();
  await expect(page.locator('.decision-heading')).toBeVisible();
  expect(requests.some((path) => path.startsWith('/api/hands?'))).toBe(true);
  const replayReads = requests.filter((path) => path.startsWith('/api/hands')).length;
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('overview-net')).not.toHaveText('—');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(requests.filter((path) => path.startsWith('/api/hands')).length).toBe(replayReads);
});

test('completed Replay freezes heavy evidence and refreshes only pending audits', async ({
  page,
}) => {
  const overview = (await (await page.request.get('/api/overview')).json()) as Overview;
  const hand = overview.recentHands[0]!;
  const detail = (await (await page.request.get(`/api/hands/${hand.id}`)).json()) as HandDetail;
  detail.hand.status = 'complete';
  detail.decisions = detail.decisions.map((decision) => ({
    ...decision,
    status: 'accepted',
    audit: {
      decisionId: decision.id,
      inputHash: null,
      computedAt: null,
      uniformShowdownReference: null,
      provenance: 'asynchronous_audit_not_model_input',
      status: 'pending',
    },
  }));
  let heavyReads = 0;
  let auditReads = 0;
  await page.route(`**/api/hands/${hand.id}`, (route) => {
    heavyReads++;
    return route.fulfill({ json: detail });
  });
  await page.route(`**/api/hands/${hand.id}/audits`, (route) => {
    auditReads++;
    return route.fulfill({
      json: detail.decisions.map((decision) => ({
        decisionId: decision.id,
        audit: {
          status: auditReads === 1 ? 'failed' : 'complete',
          computedAt: '2026-09-22T12:00:00Z',
        },
      })),
    });
  });
  await page.goto('/#replay');
  await expect(page.getByLabel('Asynchronous audit', { exact: true })).toContainText('Pending');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Asynchronous audit', { exact: true })).toContainText(
    'Worker unavailable',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Asynchronous audit', { exact: true })).toContainText('Complete');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(heavyReads).toBe(1);
  expect(auditReads).toBe(2);
  const context = page
    .locator('details')
    .filter({ has: page.getByText('Inspect decision context', { exact: true }) });
  await expect(context.locator('pre')).toHaveCount(0);
  await context.locator('summary').click();
  await expect(context.locator('pre')).toBeVisible();
});

for (const initiallyComplete of [true, false]) {
  test(`Replay admits late hand fields and settlement, complete=${initiallyComplete}`, async ({
    page,
  }) => {
    const overview = (await (await page.request.get('/api/overview')).json()) as Overview;
    const hand = overview.recentHands[0]!;
    const original = (await (await page.request.get(`/api/hands/${hand.id}`)).json()) as HandDetail;
    let detail: HandDetail = {
      ...original,
      hand: {
        ...hand,
        status: 'complete',
        complete: initiallyComplete,
        profit: null,
        board: [],
        heroCards: [],
      },
      decisions: original.decisions.map((decision) => ({
        ...decision,
        status: 'accepted',
        audit: undefined,
      })),
    };
    let reads = 0;
    let listReads = 0;
    await page.route('**/api/hands?*', (route) => {
      listReads++;
      return route.fulfill({ json: [detail.hand] });
    });
    await page.route(`**/api/hands/${hand.id}`, (route) => {
      reads++;
      return route.fulfill({ json: detail });
    });
    await page.goto('/#replay');
    await expect(page.locator('.decision-heading')).toBeVisible();
    await page.getByRole('button', { name: 'Next event', exact: true }).click();
    const slider = page.getByRole('slider', { name: 'Replay event' });
    await expect(slider).toHaveValue('1');
    const refresh = async () => {
      const previous = listReads;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => listReads).toBeGreaterThan(previous);
    };
    await refresh();
    await expect.poll(() => reads).toBe(initiallyComplete ? 1 : 2);
    detail = {
      ...detail,
      hand: {
        ...detail.hand,
        complete: true,
        profit: 120,
        board: ['As', 'Kd', 'Qc'],
        heroCards: ['Ah', 'Ac'],
      },
      events: [
        ...detail.events,
        {
          id: 'late-cards',
          type: 'community_cards',
          receivedAt: '2026-09-22T12:00:00Z',
          payload: { cards: ['As', 'Kd', 'Qc'] },
        },
      ],
    };
    await refresh();
    await expect(slider).toHaveAttribute('max', String(detail.events.length - 1));
    await expect(slider).toHaveValue('1');
    await expect(
      page.getByRole('button', {
        name: new RegExp(`Hand #${String(hand.handNumber).padStart(3, '0')}`),
      }),
    ).toContainText('+120');
    const afterCorrection = reads;
    if (initiallyComplete) expect(afterCorrection).toBe(2);
    // Fresh arrays with identical hand fields must not invalidate the loaded detail.
    await refresh();
    await refresh();
    expect(reads).toBe(afterCorrection);
  });
}
