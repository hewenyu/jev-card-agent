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
  const publishedAt = '2026-09-20T10:00:00.000Z';
  const pinnedAt = '2026-09-20T10:01:00.000Z';
  const decision: DecisionView = {
    ...detail.decisions[0]!,
    modelInput: { street: 'flop', knowledgeVersion: 'knowledge-fixture-12' },
    knowledge: {
      pin: {
        tableId: hand.tableId,
        handId: hand.id,
        knowledgeVersion: 'knowledge-fixture-12',
        snapshotHash: 'a'.repeat(64),
        evidenceEventId: 120,
        pinnedAt,
        admissibleAt: pinnedAt,
        reason: 'published',
        opponentMemory: [],
        strategyCards: [],
      },
      snapshot: {
        version: 'knowledge-fixture-12',
        contentHash: 'a'.repeat(64),
        source: 'deterministic',
        rulesetVersion: 'holdem-test',
        contextSchemaVersion: 'context-test',
        evidenceEventId: 120,
        evidenceCutoff: '2026-09-20T09:59:00.000Z',
        publishedAt,
        expiresAt: null,
        validation: ['completed hands only'],
      },
    },
    audit: {
      decisionId: detail.decisions[0]!.id,
      inputHash: null,
      computedAt: null,
      status: 'pending',
      uniformShowdownReference: null,
      provenance: 'asynchronous_audit_not_model_input',
    },
    timing: {
      receivedAt: pinnedAt,
      preparationStartedAt: pinnedAt,
      preparationMs: 12,
      knowledgeMs: 2,
      providerMs: 450,
      persistenceMs: 3,
      sendMs: 1,
      receiptToSendMs: 466,
    },
  };
  return { overview, hand, detail, decision };
}
function completedAudit(decision: DecisionView): DecisionView {
  return {
    ...decision,
    audit: {
      decisionId: decision.id,
      inputHash: 'b'.repeat(64),
      computedAt: '2026-09-20T10:02:00.000Z',
      status: 'complete',
      provenance: 'asynchronous_audit_not_model_input',
      uniformShowdownReference: {
        method: 'deterministic_monte_carlo',
        rangeAssumption: 'uniform_random_legal_hole_cards',
        seed: 123,
        winProbability: 0.6,
        tieProbability: 0.05,
        equity: 0.625,
        opponents: 2,
        samples: 1200,
        standardError: 0.01,
        caveat: 'Random legal cards, not a betting range.',
      },
    },
    timing: { ...decision.timing!, acknowledgedAt: '2026-09-20T10:01:00.486Z', ackMs: 20 },
  };
}

test('replay refresh appends an audit while preserving pinned knowledge and actual Jev input', async ({
  page,
}) => {
  const data = await fixture(page);
  let decision = data.decision;
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...data.detail, decisions: [decision] } }),
  );
  await page.goto('/#replay');
  const evidence = page.getByLabel('Knowledge and asynchronous audit');
  const audit = page.getByLabel('Asynchronous audit', { exact: true });
  await expect(evidence).toContainText('knowledge-fixture-12');
  await expect(evidence).toContainText('2026-09-20T10:00:00.000Z');
  await expect(evidence).toContainText('2026-09-20T09:59:00.000Z');
  await expect(audit.getByRole('status')).toHaveText('Pending');
  const stages = page.getByLabel('Decision stage timings', { exact: true });
  await expect(stages).toContainText('466 ms');
  await expect(
    stages.locator('div').filter({ hasText: 'First send to acknowledgement' }),
  ).toContainText('Not recorded');
  await page.getByText('Actual Jev input', { exact: true }).click();
  const actual = page
    .locator('details')
    .filter({ has: page.getByText('Actual Jev input', { exact: true }) })
    .locator('pre');
  const before = await actual.textContent();
  decision = completedAudit(decision);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(audit.getByRole('status')).toHaveText('Complete');
  await expect(audit).toContainText('62.5%');
  await expect(audit).toContainText('was not supplied to Jev');
  await expect(stages).toContainText('20 ms');
  await expect(actual).toHaveText(before!);
  await expect(actual).not.toContainText('uniformShowdownReference');
  await expect(evidence).toContainText('knowledge-fixture-12');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('Knowledge provenance', { exact: true }).click();
  await expect(evidence).toContainText('a'.repeat(64));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await evidence.screenshot({ path: 'test-results/fast-slow-mobile.png' });
});

test('live keeps the table first and refreshes worker progress independently of the hand pin', async ({
  page,
}) => {
  const data = await fixture(page);
  let runtime: RuntimeView = {
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
    research: {
      enabled: true,
      running: true,
      lastCompletedAt: null,
      eventCursor: 120,
      decisionCursor: 1,
      pendingHands: 7,
      pendingAudits: 4,
      latestVersion: 'knowledge-fixture-12',
      error: null,
    },
  };
  let decision = data.decision;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(request.method());
  });
  await page.route('**/api/live', (route) => route.abort());
  await page.route('**/api/overview', (route) =>
    route.fulfill({ json: { ...data.overview, runtime } }),
  );
  await page.route('**/api/live/decisions', (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    const json: LiveDecisions = {
      session: {
        id: 'pinned-session',
        tableId: data.hand.tableId,
        handId: data.hand.id,
        runId: data.decision.runId,
        turnCount: 1,
      },
      decisions: [decision],
    };
    return route.fulfill({ json });
  });
  await page.goto('/#live');
  await expect(page.getByRole('heading', { name: 'Live table', exact: true })).toBeVisible();
  const worker = page.getByLabel('Research worker status');
  await expect(worker).toContainText('Running');
  const headings = await page.locator('h2').allTextContents();
  expect(headings.indexOf('Live table')).toBeLessThan(headings.indexOf('Asynchronous knowledge'));
  runtime = {
    ...runtime,
    research: {
      ...runtime.research!,
      running: false,
      latestVersion: 'knowledge-fixture-13',
      pendingHands: 0,
      pendingAudits: 0,
      lastCompletedAt: '2026-09-20T10:02:00.000Z',
    },
  };
  decision = completedAudit(decision);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(worker).toContainText('knowledge-fixture-13');
  await expect(page.getByLabel('Knowledge and asynchronous audit')).toContainText(
    'knowledge-fixture-12',
  );
  await expect(
    page.getByLabel('Asynchronous audit', { exact: true }).getByRole('status'),
  ).toHaveText('Complete');
  runtime = { ...runtime, research: { ...runtime.research!, enabled: false } };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(worker).toContainText('Disabled');
  await expect(page.getByLabel('Knowledge and asynchronous audit')).toContainText(
    'knowledge-fixture-12',
  );
  expect(writes).toEqual([]);
});

test('legacy replay marks missing knowledge and stage timings without inventing pending work', async ({
  page,
}) => {
  const data = await fixture(page);
  const old: DecisionView = {
    ...data.decision,
    knowledge: undefined,
    audit: undefined,
    timing: undefined,
  };
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...data.detail, decisions: [old] } }),
  );
  await page.goto('/#replay');
  const evidence = page.getByLabel('Knowledge and asynchronous audit');
  await expect(evidence).toContainText('Knowledge pin not recorded for this historical decision.');
  await expect(
    page.getByLabel('Asynchronous audit', { exact: true }).getByRole('status'),
  ).toHaveText('Not recorded for this historical decision');
  await page.getByText('Decision stage timings', { exact: true }).click();
  await expect(evidence).toContainText('Stage timings not recorded for this historical decision.');
  await expect(evidence).not.toContainText('Pending');
});
