import { expect, test } from '@playwright/test';
import { mockOverview } from './dashboard-fixture';
import type { HandDetail, Overview } from '../../src/shared/api';
import type { FrameworkDecisionView, FrameworkStatusView } from '../../src/shared/framework';

test('live refreshes explicit research releases and renders Score evidence without public controls', async ({
  page,
}) => {
  const overview = (await (await page.request.get('/api/overview')).json()) as Overview;
  const hand = overview.recentHands[0]!;
  const detail = (await (await page.request.get(`/api/hands/${hand.id}`)).json()) as HandDetail;
  const framework: FrameworkStatusView = {
    engine: 'duelloop',
    activeReleaseDigest: 'active-release-0001',
    handReleaseDigest: 'pinned-release-0000',
    factsSnapshotDigest: 'facts-snapshot-0001',
    unresolvedIntents: 0,
    research: {
      enabled: true,
      running: true,
      paused: false,
      state: 'idle',
      provider: 'deepseek/messages/deepseek-flash',
      updatedAt: '2026-09-24T09:00:00Z',
      error: null,
      activeRunId: null,
      recentRuns: [],
      pendingReleases: [],
      activationMode: 'explicit',
      activationPaused: false,
    },
  };
  const recorded: FrameworkDecisionView = {
    decisionId: 'score-decision',
    releaseDigest: 'pinned-release-0000',
    strategyDigest: 'strategy-v1',
    factsSnapshotDigest: 'facts-snapshot-0001',
    selection: 'argmax',
    branchId: null,
    scores: [
      { candidateId: 'call', dimensionId: 'chip_quality', score: 3.5, confidence: 0.72, levels: 5 },
    ],
    utilities: { call: 0.875 },
    selectionProbabilities: { call: 1 },
    usage: {
      inputTokens: 123,
      outputTokens: 9,
      tokensComplete: true,
      costUsd: null,
      costComplete: false,
    },
    modelDeadline: null,
  };
  const decision = { ...detail.decisions[0]!, framework: recorded };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() !== 'GET')
      writes.push(request.method());
  });
  await page.route('**/api/live', (route) => route.abort());
  await mockOverview(page, (route) =>
    route.fulfill({ json: { ...overview, runtime: { ...overview.runtime, framework } } }),
  );
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...detail, decisions: [decision] } }),
  );
  await page.goto('/#live');
  await expect(page.getByRole('heading', { name: 'Strategy & research' })).toBeVisible();
  await expect(page.getByText('Explicit operator approval', { exact: true })).toBeVisible();
  framework.research.pendingReleases = [
    { digest: 'new-validated-release', validationDigest: 'independent-final-validation' },
  ];
  await expect(
    page.getByRole('heading', { name: 'Validated proposals awaiting activation' }),
  ).toBeVisible();
  await page.goto('/#replay');
  const evidence = page.getByLabel('Framework decision evidence');
  await expect(evidence).toContainText('72.0%');
  await expect(evidence).toContainText('Unknown / incomplete');
  await expect(evidence).toContainText('not 100% model confidence');
  await expect(
    page.getByRole('heading', { name: 'Provider recommendation', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(writes).toEqual([]);
});
