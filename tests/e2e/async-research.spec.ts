import { expect, test } from '@playwright/test';
import type { ResearchPublicView } from '../../src/shared/research';
import type { HandDetail, Overview } from '../../src/shared/api';

test('research observations refresh modes and publication status without public controls', async ({
  page,
}) => {
  const response = await page.request.get('/api/research');
  const view = (await response.json()) as ResearchPublicView;
  view.status.mode = 'shadow';
  view.status.configuredMode = 'live';
  view.status.running = true;
  view.status.awaitingReview = 1;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() !== 'GET')
      writes.push(request.method());
  });
  await page.route('**/api/research', (route) => route.fulfill({ json: view }));
  await page.goto('/#live');
  const panel = page.getByLabel('LLM research status');
  await expect(panel).toContainText('Research runs in shadow');
  await expect(panel).toContainText('has not been activated');
  view.status.mode = 'live';
  view.status.awaitingReview = 0;
  view.status.published = 1;
  view.status.adoptedDecisions = 2;
  view.status.evaluatedDecisions = 3;
  view.publications = [
    {
      id: 'pub-test',
      proposalId: 'prop-test',
      revision: 1,
      sequence: 1,
      status: 'published',
      publishedAt: '2026-09-22T02:00:00.000Z',
      expiresAt: '2026-09-23T02:00:00.000Z',
      evidenceCutoff: '2026-09-22T01:00:00.000Z',
      guidance: 'Consider the price and verified opportunities.',
      approvalSource: 'manual',
    },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(panel).toContainText('Jev can use approved advice');
  await expect(panel).toContainText('2 / 3 live decisions');
  await panel.getByText('Published advice history', { exact: true }).click();
  await expect(panel).toContainText('Consider the price and verified opportunities.');
  view.publications[0]!.status = 'withdrawn';
  view.status.withdrawn = 1;
  view.status.published = 0;
  view.status.mode = 'off';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(panel).toContainText('Research is off');
  await expect(panel).toContainText('withdrawn');
  await expect(panel.getByRole('button')).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await panel.screenshot({ path: 'test-results/async-research-mobile.png' });
});

test('replay distinguishes actual advice adoption from proposal existence', async ({ page }) => {
  const overview = (await (await page.request.get('/api/overview')).json()) as Overview;
  const hand = overview.recentHands[0]!;
  const detail = (await (await page.request.get(`/api/hands/${hand.id}`)).json()) as HandDetail;
  const decision = detail.decisions[0]!;
  const item = {
    id: 'pub-test',
    scope: { streets: ['river'], opponentKeys: [] },
    observation: 'Recorded opportunities.',
    guidance: 'Use the current price.',
    limitations: ['Small sample.'],
    evidence: ['calls 1/2'],
  };
  decision.context.advice = {
    mode: 'live',
    bundleHash: 'b'.repeat(64),
    selectorVersion: 'scope-selector-v1',
    selectionAt: decision.createdAt,
    knowledgeSource: 'llm-assisted',
    publicationIds: ['pub-test'],
    proposalIds: ['prop-test'],
    items: [item],
    audit: [{ id: 'pub-test', reason: 'adopted' }],
    serializedBytes: 200,
  };
  decision.modelInput = { ...decision.modelInput, approvedAdvice: [item] };
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...detail, decisions: [decision] } }),
  );
  await page.goto('/#replay');
  const evidence = page.getByLabel('Advice used by Jev');
  await expect(evidence).toContainText('present in this saved Jev request');
  await expect(evidence).toContainText('LLM-assisted');
  await expect(evidence).toContainText('Use the current price.');
  delete decision.modelInput.approvedAdvice;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(evidence).toContainText('No approved advice was included');
  await expect(evidence).not.toContainText('Use the current price.');
});
