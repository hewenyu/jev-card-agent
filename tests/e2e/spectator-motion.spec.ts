import { createServer, type ServerResponse } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import type { ChipMovement, SpectatorEvent, SpectatorSnapshot } from '../../src/shared/api';

function movement(
  id: string,
  seat: number,
  amount: number,
  direction: ChipMovement['direction'],
): ChipMovement {
  return { id, seat, amount, direction, tableId: 'public-table', handId: 'public-hand' };
}
function event(id: string, movements: ChipMovement[], action = 'call', seat = 0): SpectatorEvent {
  return {
    id,
    tableId: 'public-table',
    handId: 'public-hand',
    at: new Date().toISOString(),
    type: 'player_action',
    seat,
    action,
    movements,
  };
}
function snapshot(): SpectatorSnapshot {
  return {
    sequence: 1,
    observedAt: new Date().toISOString(),
    runtime: {
      running: true,
      status: 'playing',
      mode: 'live',
      runId: 'public-run',
      strategy: 'jev',
      error: null,
      table: {
        tableId: 'public-table',
        handId: 'public-hand',
        street: 'preflop',
        pot: 20,
        board: [],
        heroCards: [],
        heroSeat: 2,
        dealerSeat: 0,
        actorSeat: 2,
        stateSeq: 1,
        complete: false,
        seats: Array.from({ length: 6 }, (_, seat) => ({
          seat,
          name: `Bot ${seat + 1}`,
          stack: 2000,
          bet: 0,
          folded: false,
          status: 'active',
        })),
      },
    },
    recentEvents: [event('old-event', [movement('old-movement', 0, 20, 'to-pot')])],
  };
}

async function stream(page: Page) {
  let current = snapshot();
  let connections = 0;
  let pauseSnapshots = false;
  const clients = new Set<ServerResponse>();
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    if (!pauseSnapshots) {
      response.write('retry: 100\n\n');
      response.write(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n`);
    }
    clients.add(response);
    connections++;
    response.on('close', () => clients.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SSE fixture failed to bind');
  await page.route('**/api/live', (route) =>
    route.continue({ url: `http://127.0.0.1:${address.port}/` }),
  );
  return {
    get current() {
      return current;
    },
    get connections() {
      return connections;
    },
    send(next: SpectatorSnapshot) {
      current = next;
      clients.forEach((client) =>
        client.write(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n`),
      );
    },
    reconnect(pause = false) {
      pauseSnapshots = pause;
      clients.forEach((client) => client.end());
    },
    async close() {
      clients.forEach((client) => client.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function captureMovements(page: Page) {
  await page.evaluate(() => {
    const state = window as typeof window & { motionIds: string[] };
    state.motionIds = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const flights = node.matches('.chip-flight')
            ? [node]
            : [...node.querySelectorAll('.chip-flight')];
          flights.forEach((flight) =>
            state.motionIds.push(flight.getAttribute('data-movement-id')!),
          );
        }
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const recorded = (page: Page) =>
  page.evaluate(() => (window as typeof window & { motionIds: string[] }).motionIds);

test('live chips queue real movements once, clear on hand change, and do not replay on reconnect', async ({
  page,
}) => {
  const source = await stream(page);
  try {
    await page.goto('/#live');
    await expect(page.locator('.seat-2 .seat-info')).toContainText('Bot 3');
    await expect(page.locator('.seat-2')).toHaveClass(/seat-current/);
    await expect(page.locator('.chip-flight')).toHaveCount(0);
    await captureMovements(page);
    const raise = event('raise', [movement('raise-40', 2, 40, 'to-pot')], 'raise', 2);
    const call = event('call', [movement('call-40', 3, 40, 'to-pot')], 'call', 3);
    source.send({
      ...source.current,
      sequence: 2,
      recentEvents: [...source.current.recentEvents, raise],
    });
    await expect(page.locator('[data-movement-id="raise-40"]')).toBeVisible();
    source.send({
      ...source.current,
      sequence: 3,
      recentEvents: [...source.current.recentEvents, call],
    });
    source.send({ ...source.current, sequence: 4 });
    await expect(page.locator('[data-movement-id="call-40"]')).toBeVisible();
    const payout = event('payout', [movement('award-100', 4, 100, 'from-pot')], '', 4);
    source.send({
      ...source.current,
      sequence: 5,
      recentEvents: [...source.current.recentEvents, payout],
    });
    await expect(page.locator('[data-movement-id="award-100"]')).toHaveAttribute(
      'data-direction',
      'from-pot',
    );
    await expect.poll(() => recorded(page)).toEqual(['raise-40', 'call-40', 'award-100']);
    source.send({
      ...source.current,
      sequence: 6,
      runtime: {
        ...source.current.runtime,
        table: { ...source.current.runtime.table!, handId: 'next-hand', pot: 0 },
      },
      recentEvents: [],
    });
    await expect(page.locator('.chip-flight')).toHaveCount(0);
    const nextMovement = { ...movement('next-hand-call', 0, 10, 'to-pot'), handId: 'next-hand' };
    source.send({
      ...source.current,
      sequence: 7,
      recentEvents: [{ ...event('next-call', [nextMovement]), handId: 'next-hand' }],
    });
    await expect(page.locator('[data-movement-id="next-hand-call"]')).toBeVisible();
    const connections = source.connections;
    source.reconnect();
    await expect.poll(() => source.connections).toBeGreaterThan(connections);
    await expect(page.locator('.chip-flight')).toHaveCount(0);
    await expect
      .poll(() => recorded(page))
      .toEqual(['raise-40', 'call-40', 'award-100', 'next-hand-call']);
    await expect(page.locator('.hero-hole')).toHaveCount(0);
  } finally {
    await page.close();
    await source.close();
  }
});

test('disconnect retains the latest SSE table when an older HTTP request finishes late', async ({
  page,
}) => {
  const source = await stream(page);
  const template = await (await page.request.get('/api/overview')).json();
  let reads = 0;
  let releaseOld!: () => void;
  const oldResponse = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  await page.route('**/api/overview', async (route) => {
    const read = ++reads;
    if (read === 2) await oldResponse;
    await route.fulfill({
      json: {
        ...template,
        runtime: {
          ...source.current.runtime,
          table: { ...source.current.runtime.table!, pot: read <= 2 ? 20 : 80 },
        },
        runs: [
          {
            ...template.runs[0],
            id: 'public-run',
            mode: 'live',
            model: read === 1 ? 'initial-http' : read === 2 ? 'delayed-http' : 'fresh-http',
          },
        ],
      },
    });
  });
  try {
    await page.goto('/#live');
    await expect(page.getByText('initial-http', { exact: true })).toBeVisible();
    await expect(page.locator('.pot strong')).toHaveText('20');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => reads).toBe(2);
    source.send({
      ...source.current,
      sequence: 2,
      runtime: {
        ...source.current.runtime,
        table: { ...source.current.runtime.table!, pot: 60 },
      },
    });
    await expect(page.locator('.pot strong')).toHaveText('60');
    source.reconnect(true);
    await expect(page.getByText('Reconnecting live updates…', { exact: true })).toBeVisible();
    await expect(page.locator('.pot strong')).toHaveText('60');
    releaseOld();
    // The model label proves React consumed this late HTTP response, while its table stays stale.
    await expect(page.getByText('delayed-http', { exact: true })).toBeVisible();
    await expect(page.locator('.pot strong')).toHaveText('60');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('fresh-http', { exact: true })).toBeVisible();
    await expect(page.locator('.pot strong')).toHaveText('80');
  } finally {
    releaseOld();
    await page.close();
    await source.close();
  }
});

test('390px reduced-motion live table shows fold/check and numbers without chip travel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const source = await stream(page);
  try {
    await page.goto('/#live');
    await expect(page.locator('.seat-2 .seat-info')).toContainText('Bot 3');
    await captureMovements(page);
    source.send({
      ...source.current,
      sequence: 2,
      runtime: {
        ...source.current.runtime,
        table: {
          ...source.current.runtime.table!,
          pot: 60,
          actorSeat: 1,
          seats: source.current.runtime.table!.seats.map((seat) => ({
            ...seat,
            folded: seat.seat === 3,
            stack: seat.seat === 2 ? 1960 : seat.stack,
          })),
        },
      },
      recentEvents: [
        event('raise', [movement('raise', 2, 40, 'to-pot')], 'raise', 2),
        event('check', [], 'check', 0),
        event('fold', [], 'fold', 3),
      ],
    });
    await expect(page.locator('.pot strong')).toHaveText('60');
    await expect(page.locator('.seat-2 .seat-info strong')).toHaveText('1,960');
    await expect(page.locator('.seat-0 .seat-action')).toHaveText('check');
    await expect(page.locator('.seat-3')).toHaveClass(/seat-folded/);
    await expect(page.locator('.seat-3 .seat-action')).toHaveText('fold');
    await expect(page.locator('.seat-1')).toHaveClass(/seat-current/);
    await expect(page.locator('.chip-flight')).toHaveCount(0);
    expect(await recorded(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  } finally {
    await page.close();
    await source.close();
  }
});
