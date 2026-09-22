import type { Page, Route } from '@playwright/test';
import type { Overview, PerformanceView } from '../../src/shared/api';

type DataRoute = Pick<Route, 'request' | 'fetch' | 'fulfill'>;
type Handler = (route: DataRoute) => unknown;
interface Fixture {
  overview?: Handler;
  performance?: Handler;
}
const fixtures = new WeakMap<Page, Fixture>();

/** Keep overview and performance fixture producers independent while mocking one HTTP response. */
async function configure(page: Page): Promise<Fixture> {
  const existing = fixtures.get(page);
  if (existing) return existing;
  const fixture: Fixture = {};
  fixtures.set(page, fixture);
  await page.route('**/api/dashboard?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    async function capture(handler: Handler | undefined, path: string) {
      let result: Parameters<Route['fulfill']>[0] | undefined;
      if (!handler) {
        const response = await page.request.get(path);
        return { status: response.status(), json: await response.json() };
      }
      await handler({
        request: () =>
          new Proxy(route.request(), {
            get: (target, key) => {
              if (key === 'url') return () => new URL(path, route.request().url()).href;
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        fetch: (options) => page.request.get(path, options),
        fulfill: async (options) => {
          result = options;
        },
      });
      if (!result) throw new Error(`Fixture did not fulfill ${path}`);
      return result;
    }
    const result = await capture(fixture.overview, '/api/overview');
    if (result.status && result.status >= 400) return route.fulfill(result);
    const overview = result.json as Overview;
    const requested = query.get('runId');
    const current = overview.runs.find((run) => run.id === overview.runtime.runId)?.id;
    const runId = requested || current || overview.runs[0]?.id;
    let performance: PerformanceView | null = null;
    let performanceError: string | undefined;
    if ((!query.get('view') || query.get('view') === 'overview') && runId) {
      const result = await capture(
        fixture.performance,
        `/api/runs/${encodeURIComponent(runId)}/performance`,
      );
      if (result.status && result.status >= 400)
        performanceError = 'Statistics refresh is delayed.';
      else performance = result.json as PerformanceView;
    }
    return route.fulfill({ json: { overview, performance, performanceError } });
  });
  return fixture;
}

export async function mockOverview(page: Page, handler: Handler) {
  (await configure(page)).overview = handler;
}
export async function mockPerformance(page: Page, handler: Handler) {
  (await configure(page)).performance = handler;
}
