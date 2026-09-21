import { expect, test } from '@playwright/test';

test('demo supports overview, historical event replay, and a local baseline comparison', async ({
  page,
}) => {
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
  await page.getByRole('link', { name: 'Experiments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Put decisions to the test.' })).toBeVisible();
  await page.getByLabel('Compare against').selectOption('baseline');
  await page.getByRole('button', { name: 'Run comparison' }).click();
  await expect(
    page.getByText('Agreement measures consistency between policies, not correctness.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'View #1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View #1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
});

test('runtime controls are explicit and access token settings do not ask for provider credentials', async ({
  page,
}) => {
  await page.goto('/#live');
  await expect(page.getByRole('heading', { name: 'The agent’s table.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start live run', exact: true })).toBeVisible();
  await expect(page.getByText('Buy-in: 2,000 virtual chips.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /Access settings/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByText('This is separate from your Jev and OpenPoker API keys.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close access settings' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
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

test('unauthorized responses present an actionable access error', async ({ page }) => {
  await page.route('**/api/overview', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unauthorized' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Open Access settings');
  await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible();
});

test('hybrid choices appear only when a reasoning provider is configured', async ({ page }) => {
  await page.goto('/#live');
  await expect(page.getByLabel('Decision policy')).toHaveValue('jev');
  await expect(page.locator('option[value="jev-reasoning"]')).toHaveCount(0);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        capabilities: { ...data.capabilities, jevConfigured: true, reasoningConfigured: true },
      },
    });
  });
  await page.reload();
  await page.getByLabel('Decision policy').selectOption('jev-reasoning');
  await expect(
    page.getByText('Jev decides when to request reasoning, then makes the final legal choice.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Experiments', exact: true }).click();
  await page.getByLabel('Compare against').selectOption('jev-reasoning');
  await expect(page.getByText('Both providers are metered.', { exact: false })).toBeVisible();
  // Selecting a mode must not itself start an Arena run or request paid analysis.
  await expect(page.getByRole('button', { name: 'Run comparison' })).toBeVisible();
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
  await page.getByRole('link', { name: 'Replay & decisions' }).click();
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
