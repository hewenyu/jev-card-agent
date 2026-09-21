import { expect, test } from '@playwright/test';

test('public site supports overview, historical replay, and recorded evaluation results', async ({
  page,
}) => {
  const overview = await (await page.request.get('/api/overview')).json();
  const hand = await (await page.request.get(`/api/hands/${overview.recentHands[0].id}`)).json();
  await page.route('**/api/evaluations', (route) =>
    route.fulfill({
      json: [
        {
          id: 'recorded-evaluation',
          createdAt: '2026-09-20T12:00:00Z',
          sourceRunId: hand.hand.runId,
          strategy: 'baseline',
          samples: 1,
          agreements: 1,
          errors: 0,
          costUsd: 0,
          meanLatencyMs: 1,
          rows: [
            {
              decisionId: hand.decisions[0].id,
              original: 'call',
              alternative: 'call',
              status: 'complete',
            },
          ],
        },
      ],
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Every decision. An open record.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Selected run')).toHaveValue(/demo/);
  await expect(
    page.getByText('Selected run only. Demo results never count as Arena results.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Replay hand/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Replay the evidence.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
  const slider = page.getByRole('slider', { name: 'Replay event' });
  await expect(slider).toHaveValue('0');
  await expect(page.locator('.table-center .cards')).toHaveAttribute(
    'aria-label',
    'No cards revealed',
  );
  await page.getByRole('button', { name: 'Next event' }).click();
  await expect(slider).toHaveValue('1');
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page.locator('.table-center .cards')).toHaveAttribute(
    'aria-label',
    /As, 7d, 2c, Tc, 4h/,
  );
  await expect(
    page.getByText(
      'Choice probabilities describe the model’s selection, not the probability of winning the hand.',
    ),
  ).toBeVisible();
  await page.getByText('Inspect decision context').click();
  await expect(page.locator('.context-details pre')).toBeVisible();
  await page.getByLabel('Result filter').selectOption('lost');
  await expect(page.locator('.hand-list .hand-item')).toHaveCount(1);
  await page.getByRole('link', { name: 'Evaluations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The choices, compared.' })).toBeVisible();
  await expect(
    page.getByText('Agreement measures consistency between policies, not correctness.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'View #1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View #1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
});

test('all public pages issue anonymous reads and expose no bot controls even with legacy credentials', async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('jev.console.token', 'retired-browser-token'),
  );
  const requests: { method: string; authorization?: string }[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      requests.push({ method: request.method(), authorization: request.headers().authorization });
  });
  // A local backend may allow controls; the public frontend must still expose none.
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        capabilities: {
          canControl: true,
          jevConfigured: true,
          reasoningConfigured: true,
          liveConfigured: true,
        },
      },
    });
  });
  await page.goto('/#live');
  await expect(page.getByRole('heading', { name: 'The agent’s table.' })).toBeVisible();
  for (const view of ['Overview', 'Live table', 'Replay & decisions', 'Evaluations']) {
    await page.getByRole('link', { name: view, exact: true }).click();
    await expect(
      page.getByRole('button', {
        name: /Access settings|Start live run|Stop|Run comparison|Explore demo/i,
      }),
    ).toHaveCount(0);
    await expect(page.getByLabel('Decision policy')).toHaveCount(0);
    await expect(page.locator('input[type="password"], form')).toHaveCount(0);
  }
  expect(requests.length).toBeGreaterThan(4);
  expect(requests.every((request) => request.method === 'GET' && !request.authorization)).toBe(
    true,
  );
  expect(await page.evaluate(() => sessionStorage.getItem('jev.console.token'))).toBeNull();
});

test('mobile console keeps navigation and replay usable without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Every decision. An open record.' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Replay & decisions' }).click();
  await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);
  await page.getByRole('button', { name: 'Next event' }).click();
  await expect(page.getByRole('slider', { name: 'Replay event' })).toHaveValue('1');
});

test('unavailable public data offers retry without a login prompt', async ({ page }) => {
  await page.route('**/api/overview', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unauthorized' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Public data is temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible();
});

test('public replay displays reasoning provider provenance and failures', async ({ page }) => {
  await page.route('**/api/hands/*', async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    const decisions = detail.decisions.map((decision: Record<string, unknown>) => ({
      ...decision,
      routing: {
        mode: 'hybrid',
        outcome: 'analysis_or_reconsider_failed',
        errorCode: 'reasoning_model_mismatch',
      },
      attempts: [
        {
          provider: 'messages',
          requestedModel: 'requested-test-model',
          actualModel: 'different-test-model',
          status: 'model_mismatch',
          latencyMs: 30,
        },
      ],
    }));
    await route.fulfill({ json: { ...detail, decisions } });
  });
  await page.goto('/#replay');
  await expect(
    page.getByRole('heading', { name: 'Initial Jev choice retained · provider failure' }),
  ).toBeVisible();
  await expect(page.getByLabel('Provider trace')).toContainText('model mismatch');
  await expect(page.getByLabel('Provider trace')).toContainText('requested-test-model');
});

test('unverified ended hands do not appear as zero profit or inflate the displayed metric sample', async ({
  page,
}) => {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        runs: data.runs.map((run: Record<string, unknown>) => ({
          ...run,
          hands: 1,
          settledHands: 0,
          excludedHands: 1,
          netChips: 0,
          bb100: null,
        })),
      },
    });
  });
  await page.route('**/api/hands?*', async (route) => {
    const response = await route.fetch();
    const hands = await response.json();
    await route.fulfill({
      json: hands.slice(0, 1).map((hand: Record<string, unknown>) => ({
        ...hand,
        status: 'complete',
        complete: false,
        profit: null,
      })),
    });
  });
  await page.goto('/');
  const net = page.locator('.metric').filter({ hasText: 'Net result' });
  await expect(net.locator('strong')).toHaveText('—');
  await expect(page.getByText('0 verified · 1 excluded')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Unverified', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Replay & decisions' }).click();
  await expect(page.locator('.hand-item').getByText('Unverified', { exact: true })).toBeVisible();
});

test('a hero seated on the right keeps both hole cards inside the replay table', async ({
  page,
}) => {
  await page.route('**/api/hands/*', async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    const events = detail.events.map(
      (event: { type: string; payload: Record<string, unknown> }) => ({
        ...event,
        payload: { ...event.payload, ...(event.type === 'hand_start' ? { seat: 4 } : {}) },
      }),
    );
    await route.fulfill({ json: { ...detail, events } });
  });
  await page.goto('/#replay');
  await page.getByRole('button', { name: 'Next event' }).click();
  await expect(page.locator('.seat-4 .hero-hole .playing-card')).toHaveCount(2);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const table = await page.locator('.poker-scene').boundingBox();
    const cards = await page.locator('.seat-4 .hero-hole').boundingBox();
    expect(table).not.toBeNull();
    expect(cards).not.toBeNull();
    expect(cards!.x).toBeGreaterThanOrEqual(table!.x);
    expect(cards!.x + cards!.width).toBeLessThanOrEqual(table!.x + table!.width);
  }
});

test('evaluation history refreshes automatically while preserving the selected result', async ({
  page,
}) => {
  const evaluation = {
    id: 'original-evaluation',
    createdAt: '2026-09-20T12:00:00Z',
    sourceRunId: 'demo-jev',
    strategy: 'baseline',
    samples: 1,
    agreements: 1,
    errors: 0,
    costUsd: 0,
    meanLatencyMs: 1,
    rows: [],
  };
  let publishNew = false;
  let reads = 0;
  await page.route('**/api/evaluations', (route) => {
    reads++;
    return route.fulfill({
      json: publishNew
        ? [{ ...evaluation, id: 'new-evaluation', samples: 3, strategy: 'jev' }, evaluation]
        : [evaluation],
    });
  });
  await page.goto('/#experiments');
  await expect(page.locator('.evaluation-item')).toHaveCount(1);
  await expect(page.locator('.evaluation-item.selected')).toContainText('Rule baseline');
  publishNew = true;
  await expect(page.locator('.evaluation-item')).toHaveCount(2);
  await expect(page.locator('.evaluation-item.selected')).toContainText('Rule baseline');
  await expect(page.locator('.evaluation-metrics').getByText('1', { exact: true })).toHaveCount(2);
  expect(reads).toBeGreaterThan(1);
  await page.getByRole('button', { name: /Jev Choice/ }).click();
  await expect(page.locator('.evaluation-metrics').getByText('3', { exact: true })).toBeVisible();
});
