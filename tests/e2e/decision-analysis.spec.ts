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
  const first: DecisionView = {
    ...detail.decisions[0]!,
    context: {
      ...detail.decisions[0]!.context,
      harness: undefined,
      opponentMemory: undefined,
      holeCards: ['Ah', 'Kd'],
      opponents: [
        { name: 'Observed rival', hands: 10, vpip: 4, pfr: 2, facedBet: 5, foldedToBet: 1 },
      ],
      session: {
        id: 'fixture-session',
        decisionId: detail.decisions[0]!.id,
        turn: 2,
        previousTurns: [
          {
            decisionId: 'prior-turn',
            street: 'preflop',
            status: 'accepted',
            action: { kind: 'raise', raiseToChips: 80 },
            analysis: 'Earlier analysis used only preflop information.',
          },
        ],
        truncated: false,
      },
      recentOutcomes: [
        {
          handId: 'earlier-verified-hand',
          profitBb: 2.5,
          decisions: [{ street: 'preflop', action: 'call' }],
          decisionsTruncated: false,
        },
      ],
    },
    routing: {
      outcome: 'reasoned_jev_final',
      reasoningMode: 'always',
      analysis:
        'A small raise is supported by the recorded opponent sample. ' + 'uncertain_'.repeat(55),
      thinking:
        'The provider returned this concise summary: consider position, pot odds, and the small observed sample.',
      thinkingSource: 'summary',
      requestedModel: 'fixture-reasoning-model',
      actualModel: 'fixture-reasoning-model',
    },
    attempts: [
      {
        provider: 'messages',
        purpose: 'analysis',
        requestedModel: 'fixture-reasoning-model',
        actualModel: 'fixture-reasoning-model',
        status: 'succeeded',
        latencyMs: 120,
      },
      {
        provider: 'jev',
        purpose: 'reconsider',
        requestedModel: 'jev-1.13.0',
        actualModel: 'jev-1.13.0',
        status: 'succeeded',
        latencyMs: 60,
      },
    ],
  };
  return { overview, hand, detail, first };
}

async function liveFixture(page: Page) {
  const base = await fixture(page);
  const runtime: RuntimeView = {
    ...base.overview.runtime,
    running: true,
    status: 'playing',
    mode: 'live',
    runId: base.first.runId,
    strategy: 'jev-reasoning',
    table: {
      tableId: base.hand.tableId,
      handId: base.hand.id,
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
      id: 'working-turn',
      sessionId: 'fixture-session',
      tableId: base.hand.tableId,
      handId: base.hand.id,
      phase: 'reasoning',
      startedAt: base.first.createdAt,
      updatedAt: base.first.createdAt,
    },
  };
  const state = {
    runtime,
    data: {
      session: {
        id: 'fixture-session',
        tableId: base.hand.tableId,
        handId: base.hand.id,
        runId: base.first.runId,
        turnCount: 1,
      },
      decisions: [base.first],
    } as LiveDecisions,
    reads: 0,
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(request.method());
  });
  // Runtime data is supplied through the existing overview fallback; no real arena connection.
  await page.route('**/api/live', (route) => route.abort());
  await mockOverview(page, (route) =>
    route.fulfill({ json: { ...base.overview, runtime: state.runtime } }),
  );
  return { ...base, state, writes };
}

test('replay presents provider analysis, actual summary and evidence with sample denominators', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...data.detail, decisions: [data.first] } }),
  );
  await page.goto('/#replay');
  await expect(
    page.getByRole('heading', { name: 'Provider recommendation', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText('A small raise is supported by the recorded opponent sample.', { exact: false })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Provider thinking summary', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('The provider returned this concise summary:', { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByLabel('Opponent statistics')).toContainText('40% · 4/10');
  await expect(page.getByLabel('Opponent statistics')).toContainText('20% · 2/10');
  await expect(page.getByLabel('Opponent statistics')).toContainText('20% · 1/5');
  await page.getByText('Earlier turns in this session · 1 included', { exact: true }).click();
  await expect(
    page.getByText('Earlier analysis used only preflop information.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('preflop · raise to 80 · accepted', { exact: true })).toBeVisible();
  await page.getByText('Verified historical outcomes · 1 included', { exact: true }).click();
  await expect(page.getByText('+2.5 bb', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Provider trace')).toContainText('Reasoning analysis');
  await expect(page.getByLabel('Provider trace')).toContainText('Final Jev choice');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const prose = await page
    .locator('.analysis-recommendation > .analysis-prose')
    .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(prose.scroll).toBeLessThanOrEqual(prose.width);
});

test('harness replay separates calculated facts, random-range assumptions and audit-only outcomes on mobile', async ({
  page,
}) => {
  const data = await fixture(page);
  const decision: DecisionView = {
    ...data.first,
    modelInput: {
      street: 'flop',
      holeCards: ['Ah', 'Kd'],
      evidencePolicy: 'Saved projected request',
    },
    modelQuestions: {
      action: {
        instructions: 'Choose a legal candidate',
        criteria: { call: { additionalChips: 100 } },
      },
    },
    context: {
      ...data.first.context,
      harness: {
        version: 'poker-harness-v1',
        cards: {
          madeHand: { name: 'one_pair', ranks: [14, 13, 9, 5] },
          bestFive: { playsBoard: false },
          board: { paired: false, maximumSameSuit: 2 },
          draws: { straightCompletionCards: [], flushCompletionCards: [] },
        },
        position: { hero: 'BTN' },
        betting: {
          heroStackChips: 980,
          heroStreetBetChips: 20,
          callChips: 100,
          contestablePotBeforeCallChips: 300,
          requiredEquityToCall: 0.25,
          activeOpponents: 2,
          priceQualification: 'Break-even showdown share if betting ends after calling.',
        },
        uniformShowdownReference: {
          equity: 0.625,
          samples: 1200,
          opponents: 2,
          standardError: 0.01,
        },
      },
      opponentMemory: { opponents: [{ name: 'Observed rival', observedHands: 10 }] },
    },
  };
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...data.detail, decisions: [decision] } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#replay');
  const evidence = page.getByLabel('Poker harness evidence', { exact: true });
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText('Jev selects the final action');
  await expect(evidence).toContainText('one pair');
  await expect(evidence).toContainText('Rank / kickers: A · K · 9 · 5');
  await expect(evidence).toContainText('980 chips');
  await expect(evidence).toContainText('20 chips');
  await expect(evidence).toContainText('100 chips');
  await expect(evidence).toContainText('25%');
  const reference = page.getByLabel('Uniform random range reference');
  await expect(reference).toContainText('62.5%');
  await expect(reference).toContainText('not the actual win probability');
  await expect(reference).toContainText('Audit reference · excluded from Jev input');
  await page.getByText('Actual Jev input', { exact: true }).click();
  const actualInput = page
    .locator('details')
    .filter({ has: page.getByText('Actual Jev input', { exact: true }) });
  await expect(actualInput.locator('pre')).toContainText('Saved projected request');
  await expect(actualInput.locator('pre')).not.toContainText('uniformShowdownReference');
  await page.getByText('Decision instructions and candidate costs', { exact: true }).click();
  await expect(page.locator('pre').filter({ hasText: 'additionalChips' })).toContainText('100');
  await page.getByText('Verified historical outcomes · 1 audit only', { exact: true }).click();
  await expect(page.getByText('Retained for audit;', { exact: false })).toBeVisible();
  await page.getByText('Opponent memory available at this turn', { exact: true }).click();
  await expect(evidence.locator('pre').last()).toContainText('Observed rival');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('replay identifies disabled DeepSeek thinking while retaining analysis and the final Jev choice', async ({
  page,
}) => {
  const data = await fixture(page);
  const decision: DecisionView = {
    ...data.first,
    routing: {
      ...data.first.routing,
      thinking: null,
      thinkingSource: 'not_provided',
      requestedModel: 'deepseek-flash',
      actualModel: 'deepseek-flash',
    },
    attempts: [
      {
        ...data.first.attempts![0]!,
        provider: 'deepseek',
        requestedModel: 'deepseek-flash',
        actualModel: 'deepseek-flash',
        configuration: { thinking: 'disabled' },
      },
      data.first.attempts![1]!,
    ],
  };
  await page.route('**/api/hands/*', (route) =>
    route.fulfill({ json: { ...data.detail, decisions: [decision] } }),
  );
  await page.goto('/#replay');
  await expect(
    page.getByText('Thinking was disabled for this request.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Provider trace')).toContainText('deepseek-flash');
  await expect(page.getByLabel('Provider trace')).toContainText('Thinking disabled');
  await expect(page.getByLabel('Provider trace')).not.toContainText('Effort');
  await expect(page.getByLabel('Provider trace')).toContainText('Final Jev choice');
  await expect(page.locator('.analysis-recommendation')).toContainText(
    'A small raise is supported by the recorded opponent sample.',
  );
  await expect(
    page.getByText('No thinking text or summary was returned in this record.', { exact: true }),
  ).toHaveCount(0);
});

test('live displays the agent cards and progress, refreshes saved turns and preserves the selected turn', async ({
  page,
}) => {
  const data = await liveFixture(page);
  await page.route('**/api/live/decisions', (route) => {
    data.state.reads++;
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ json: data.state.data });
  });
  await page.goto('/#live');
  await expect(page.locator('.seat-0 .hero-hole .cards')).toHaveAttribute('aria-label', 'Ah, Kd');
  await expect(page.locator('.hand-session-summary')).toContainText('Analyzing the hand');
  await expect(page.getByRole('group', { name: 'Session turns' }).getByRole('button')).toHaveCount(
    1,
  );
  data.state.data = {
    ...data.state.data,
    session: { ...data.state.data.session!, turnCount: 2 },
    decisions: [
      data.first,
      { ...data.first, id: 'newer-live-turn', routing: undefined, attempts: [] },
    ],
  };
  data.state.runtime = {
    ...data.state.runtime,
    decision: { ...data.state.runtime.decision!, phase: 'submitted' },
  };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('group', { name: 'Session turns' }).getByRole('button')).toHaveCount(
    2,
    { timeout: 10_000 },
  );
  await expect(page.getByRole('button', { name: /^Turn 1 / })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.hand-session-summary')).toContainText('Action submitted');
  await page.getByRole('button', { name: /^Turn 2 / }).click();
  await expect(
    page.getByText('This record does not include a provider analysis.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('No thinking text or summary was returned in this record.', { exact: true }),
  ).toBeVisible();
  const reads = data.state.reads;
  await expect.poll(() => data.state.reads, { timeout: 10_000 }).toBeGreaterThan(reads);
  await expect(page.getByRole('button', { name: /^Turn 2 / })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(data.writes).toEqual([]);
});

test('a previous hand response cannot replace the new live decision session', async ({ page }) => {
  const data = await liveFixture(page);
  let releaseOld!: () => void;
  const pending = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let held = false;
  await page.route('**/api/live/decisions', async (route) => {
    data.state.reads++;
    const response = structuredClone(data.state.data);
    if (data.state.reads === 2) {
      held = true;
      await pending;
    }
    await route.fulfill({ json: response });
  });
  try {
    await page.goto('/#live');
    await expect(
      page.getByRole('heading', { name: 'Provider recommendation', exact: true }),
    ).toBeVisible();
    await expect.poll(() => held, { timeout: 10_000 }).toBe(true);
    const nextHand = 'next-live-hand';
    data.state.runtime = {
      ...data.state.runtime,
      table: { ...data.state.runtime.table!, handId: nextHand },
      decision: null,
    };
    data.state.data = {
      session: { ...data.state.data.session!, id: 'next-session', handId: nextHand, turnCount: 1 },
      decisions: [
        {
          ...data.first,
          id: 'next-hand-choice',
          handId: nextHand,
          context: { ...data.first.context, session: { id: 'next-session', turn: 1 } },
          routing: { analysis: 'Analysis for the new hand only.' },
        },
      ],
    };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Analysis for the new hand only.', { exact: true })).toBeVisible();
    const response = page.waitForResponse((item) => item.url().endsWith('/api/live/decisions'));
    releaseOld();
    await response;
    await expect(page.getByText('Analysis for the new hand only.', { exact: true })).toBeVisible();
    await expect(page.locator('.hand-session-summary')).toContainText('next-session');
    await expect(
      page.getByText('A small raise is supported by the recorded opponent sample.', {
        exact: false,
      }),
    ).toHaveCount(0);
  } finally {
    releaseOld();
  }
});
