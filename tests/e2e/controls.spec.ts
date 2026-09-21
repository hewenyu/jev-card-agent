import { expect, test, type Locator, type Page } from '@playwright/test';

function luminance(color: string) {
  const channels = color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map((part) => {
      const value = Number(part) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

async function expectDarkControl(control: Locator) {
  const appearance = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    const option = element.querySelector('option');
    return {
      scheme: style.colorScheme,
      foreground: style.color,
      background: style.backgroundColor,
      optionForeground: option ? getComputedStyle(option).color : null,
      optionBackground: option ? getComputedStyle(option).backgroundColor : null,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(appearance.scheme).toBe('dark');
  expect(luminance(appearance.background)).toBeLessThan(0.1);
  expect(contrast(appearance.foreground, appearance.background)).toBeGreaterThanOrEqual(4.5);
  expect(luminance(appearance.optionBackground!)).toBeLessThan(0.1);
  expect(
    contrast(appearance.optionForeground!, appearance.optionBackground!),
  ).toBeGreaterThanOrEqual(4.5);
  expect(appearance.height).toBeGreaterThanOrEqual(40);
}

async function expectContained(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    controls: [...document.querySelectorAll('select')].map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, height: box.height };
    }),
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  for (const control of dimensions.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(dimensions.viewport);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
}

test('run, result and decision dropdowns keep dark native options and visible keyboard focus', async ({
  page,
}) => {
  await page.goto('/#replay');
  await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
  const run = page.getByLabel('Selected run');
  const filter = page.getByLabel('Result filter');
  const decision = page.getByLabel('Decision', { exact: true });
  const allHands = await page.locator('.hand-item').count();
  for (const control of [run, filter, decision]) {
    await expectDarkControl(control);
    await control.focus();
    await expect(control).toBeFocused();
    expect(await control.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      'solid',
    );
    expect(await control.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('2px');
  }
  await filter.focus();
  await page.keyboard.press('l');
  await expect(filter).toHaveValue('lost');
  await expect(page.locator('.hand-item')).toHaveCount(1);
  await filter.selectOption('all');
  await expect(filter).toHaveValue('all');
  await expect(page.locator('.hand-item')).toHaveCount(allHands);
  const previous = page.getByRole('button', { name: 'Previous event', exact: true });
  await expect(previous).toBeDisabled();
  expect(await previous.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await page.getByRole('slider', { name: 'Replay event' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(previous).toBeEnabled();
  await filter.click();
  await page.screenshot({ path: test.info().outputPath('desktop-native-dropdown.png') });
  await page.keyboard.press('Escape');
});

test('390px controls and long recorded details stay inside every public page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url());
  });
  await page.route('**/api/hands/*', async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({
      json: {
        ...detail,
        decisions: detail.decisions.map((decision: Record<string, unknown>) => ({
          ...decision,
          model: 'public-recorded-reasoning-model-with-a-long-version-identifier',
          context: {
            ...(decision.context as Record<string, unknown>),
            sessionId:
              'table-00000000-1111-4222-8333-444444444444:hand-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          },
        })),
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Results at a glance.' })).toBeVisible();
  const headings: Record<string, string> = {
    Overview: 'Results at a glance.',
    'Live table': 'The agent’s table.',
    'Replay & decisions': 'Replay the evidence.',
    Evaluations: 'The choices, compared.',
  };
  for (const [view, heading] of Object.entries(headings)) {
    await page.getByRole('link', { name: view, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (view === 'Replay & decisions') {
      await expect(page.getByRole('heading', { name: 'Decision trace' })).toBeVisible();
      await page.getByText('Inspect decision context', { exact: true }).click();
      await expect(page.locator('.context-details pre')).toBeVisible();
    }
    await expectContained(page);
    await page.screenshot({
      path: test.info().outputPath(`mobile-${view.replaceAll(' ', '-')}.png`),
      fullPage: true,
    });
  }
  expect(writes).toEqual([]);
});
