import { mockOverview } from './dashboard-fixture';
import { expect, test, type Page } from '@playwright/test';
import type {
  DecisionView,
  HandDetail,
  LiveDecisions,
  Overview,
  RuntimeView,
} from '../../src/shared/api';

async function fixture(page: Page) {
  const overview = (await (await page.request.get('/api/overview')).json()) as Overview;
  const hand = overview.recentHands[0]!;
  const detail = (await (await page.request.get(`/api/hands/${hand.id}`)).json()) as HandDetail;
  const first = detail.decisions[0]!;
  const decision: DecisionView = {
    ...first,
    source: 'unavailable',
    status: 'failed',
    selectedCandidateId: null,
    probabilities: {},
    confidence: null,
    model: null,
    fallbackReason: 'Jev API returned HTTP 503',
    routing: undefined,
    context: {
      ...first.context,
      session: { id: 'failed-hand-session', turn: 1, previousTurns: [], truncated: false },
    },
    attempts: Array.from({ length: 4 }, (_, retryIndex) => ({
      provider: 'jev',
      purpose: 'decision',
      requestedModel: 'jev-1.13.0',
      actualModel: null,
      status: 'failed',
      latencyMs: 100,
      retryIndex,
      maxRetries: 3,
      errorCode: 'Jev API returned HTTP 503',
    })),
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(request.url());
  });
  return { overview, hand, detail, decision, writes };
}

async function assertFailure(page: Page) {
  await expect(
    page.getByRole('heading', { name: 'Model decision failed · no action submitted', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Model decision failed · bot paused', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Failure reason: Jev API returned HTTP 503', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Recorded choice comparison')).toContainText('No action submitted');
  await expect(page.getByLabel('Recorded choice comparison')).not.toContainText(
    'Runtime fallback choice',
  );
  await expect(page.locator('.candidate.chosen')).toHaveCount(0);
  await expect(page.locator('.provider-attempt')).toHaveCount(4);
  await expect(page.getByLabel('Provider trace')).toContainText('Initial attempt');
  await expect(page.getByLabel('Provider trace')).toContainText('Retry 3 of 3');
  await expect(page.getByRole('button', { name: /resume|start bot|stop bot/i })).toHaveCount(0);
}

test('failed model decisions remain reviewable with all retries and no local action in replay', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...data.detail, decisions: [data.decision] } }),
  );
  await page.goto('/#replay');
  await assertFailure(page);
  await expect(page.getByText('Model unavailable', { exact: false }).first()).toBeVisible();
  expect(data.writes).toEqual([]);
});

test('live failure refresh pauses the displayed session without exposing a public resume control', async ({
  page,
}) => {
  const data = await fixture(page);
  const runtime: RuntimeView = {
    ...data.overview.runtime,
    running: true,
    status: 'playing',
    mode: 'live',
    runId: data.decision.runId,
    strategy: 'jev',
    table: {
      tableId: data.hand.tableId,
      handId: data.hand.id,
      street: 'flop',
      pot: 120,
      board: ['2h', '3d', '4s'],
      heroCards: ['Ah', 'Kd'],
      heroSeat: 0,
      dealerSeat: 1,
      actorSeat: 0,
      seats: [{ seat: 0, name: 'Agent', stack: 1900, bet: 20, folded: false, status: 'active' }],
    },
    decision: {
      id: data.decision.id,
      sessionId: 'failed-hand-session',
      tableId: data.hand.tableId,
      handId: data.hand.id,
      phase: 'jev',
      startedAt: data.decision.createdAt,
      updatedAt: data.decision.createdAt,
    },
  };
  const state = {
    runtime,
    data: {
      session: {
        id: 'failed-hand-session',
        tableId: data.hand.tableId,
        handId: data.hand.id,
        runId: data.decision.runId,
        turnCount: 0,
      },
      decisions: [],
    } as LiveDecisions,
  };
  await page.route('**/api/live', (route) => route.abort());
  await mockOverview(page, (route) =>
    route.fulfill({ json: { ...data.overview, runtime: state.runtime } }),
  );
  await page.route('**/api/live/decisions', (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ json: state.data });
  });
  await page.goto('/#live');
  await expect(page.locator('.hand-session-summary')).toContainText(
    'Jev is choosing the final action',
  );
  state.runtime = {
    ...state.runtime,
    status: 'stopping',
    error: data.decision.fallbackReason,
    decision: { ...state.runtime.decision!, phase: 'failed' },
  };
  state.data = { session: { ...state.data.session!, turnCount: 1 }, decisions: [data.decision] };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.hand-session-summary')).toContainText(
    'Model decision failed · bot paused',
    { timeout: 10000 },
  );
  await assertFailure(page);
  await expect(page.getByRole('group', { name: 'Session turns' })).toContainText('failed');
  expect(data.writes).toEqual([]);
});
