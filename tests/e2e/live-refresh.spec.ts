import { mockOverview } from './dashboard-fixture';
import { expect, test } from '@playwright/test';
import type { Overview, RuntimeView, SpectatorSnapshot } from '../../src/shared/api';

type StreamWindow = Window & { emitTableSnapshot: (snapshot: SpectatorSnapshot) => void };

test('Live polling refreshes all stacks and bets when an open stream stops advancing', async ({
  page,
}) => {
  const original = (await (await page.request.get('/api/overview')).json()) as Overview;
  function runtime(stateSeq: number, contribution: number): RuntimeView {
    return {
      ...original.runtime,
      mode: 'live',
      running: true,
      status: 'playing',
      strategy: 'jev',
      runId: 'refresh-run',
      table: {
        tableId: 'refresh-table',
        handId: 'refresh-hand',
        street: 'preflop',
        pot: contribution * 6,
        board: [],
        heroCards: ['Ah', 'Kd'],
        heroSeat: 0,
        dealerSeat: 1,
        stateSeq,
        seats: Array.from({ length: 6 }, (_, seat) => ({
          seat,
          name: seat === 0 ? 'Jev agent' : `Opponent ${seat}`,
          stack: 2000 + seat * 100 - contribution,
          bet: contribution,
          folded: false,
          status: 'active',
        })),
      },
    };
  }
  let overviewRuntime = runtime(10, 0);
  let overviewRequests = 0;
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
        (window as unknown as StreamWindow).emitTableSnapshot = (snapshot) => {
          this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }));
        };
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    }
    window.EventSource = TestEventSource as unknown as typeof EventSource;
  });
  await mockOverview(page, (route) => {
    overviewRequests++;
    return route.fulfill({ json: { ...original, runtime: overviewRuntime } });
  });
  await page.route('**/api/live/decisions', (route) =>
    route.fulfill({ json: { session: null, decisions: [] } }),
  );
  let sequence = 0;
  async function send(value: RuntimeView) {
    await page.evaluate(
      (snapshot) => (window as unknown as StreamWindow).emitTableSnapshot(snapshot),
      {
        sequence: ++sequence,
        observedAt: new Date().toISOString(),
        runtime: value,
        recentEvents: [],
      },
    );
  }
  async function assertSeats(contribution: number) {
    for (let seat = 0; seat < 6; seat++) {
      const player = page.locator(`.poker-scene [data-seat="${seat}"]`);
      await expect(player.locator('.seat-info strong')).toHaveText(
        (2000 + seat * 100 - contribution).toLocaleString('en-US'),
      );
      await expect(player.locator('.seat-bet')).toHaveText(`Bet ${contribution}`);
    }
  }
  await page.goto('/#live');
  await expect(page.getByRole('heading', { name: 'The agent’s table.' })).toBeVisible();
  await expect(page.getByText('JEV → ACTION', { exact: true })).toBeVisible();
  await expect(page.getByText('REASONING → JEV → ACTION', { exact: true })).toHaveCount(0);
  await send(overviewRuntime);
  await expect(page.getByText('Live updates connected', { exact: true })).toBeVisible();
  await assertSeats(0);

  // Leave the stream open without sending another snapshot; polling must win by table_seq.
  const before = overviewRequests;
  overviewRuntime = runtime(12, 50);
  await expect.poll(() => overviewRequests, { timeout: 10_000 }).toBeGreaterThan(before);
  await assertSeats(50);
  await expect(page.getByText('Live updates connected', { exact: true })).toBeVisible();

  // A newer SSE envelope can still carry an older table; it must not undo the HTTP update.
  await send(runtime(11, 20));
  await assertSeats(50);

  // Conversely, a newer table from the stream survives the next older HTTP response.
  await send(runtime(13, 80));
  await assertSeats(80);
  const after = overviewRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => overviewRequests).toBeGreaterThan(after);
  await assertSeats(80);
});
