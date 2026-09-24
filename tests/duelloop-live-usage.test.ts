import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { LiveUsageLedger } from '../src/duelloop/live/usage.js';
import { withModelDeadline } from '../src/duelloop/live/model.js';
import type { ModelAttempt } from '../src/duelloop/model.js';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  store.acquireLease();
  return { store, ledger: new LiveUsageLedger(store, 'old-run', 'jev-test') };
}
const attempt: ModelAttempt = {
  requestId: 'request',
  requestHash: 'hash',
  retryIndex: 0,
  startedAt: new Date().toISOString(),
  latencyMs: 10,
  status: 'succeeded',
  actualModel: 'jev-test',
  usage: { inputTokens: 10, outputTokens: 2, unknown: false, costUnknown: true },
};

it('persists request attribution and usage in the same transaction, including failed writes', async () => {
  const { store, ledger } = setup();
  await withModelDeadline(Date.now() + 1000, async () => ledger.start(attempt), 'original-turn');
  expect(store.db.prepare('SELECT context_id FROM framework_calls').get()?.context_id).toBe(
    'original-turn',
  );
  expect(() => ledger.start(attempt)).toThrow();
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM usage').get()?.n).toBe(1);
  store.db.exec(
    "CREATE TRIGGER reject_result BEFORE UPDATE OF result ON framework_calls BEGIN SELECT RAISE(ABORT,'disk failure fixture'); END;",
  );
  expect(() => ledger.finish(attempt)).toThrow('disk failure fixture');
  expect(store.db.prepare('SELECT status FROM usage').get()?.status).toBe('reserved');
  expect(store.db.prepare('SELECT status FROM provider_usage').get()?.status).toBe('reserved');
  expect(store.db.prepare('SELECT result FROM framework_calls').get()?.result).toBeNull();
  store.db.exec('DROP TRIGGER reject_result');
  ledger.finish(attempt);
  expect(store.db.prepare('SELECT status FROM usage').get()?.status).toBe('settled');
  expect(
    JSON.parse(String(store.db.prepare('SELECT result FROM framework_calls').get()?.result)),
  ).toEqual(attempt);
});

it('classifies interrupted older requests as unknown while preserving completed usage', () => {
  const { store, ledger } = setup();
  ledger.start(attempt);
  const complete = { ...attempt, requestId: 'complete' };
  ledger.start(complete);
  ledger.finish(complete);
  new LiveUsageLedger(store, 'next-run', 'jev-test');
  expect(
    store.db
      .prepare(
        'SELECT u.status,u.charged_nanos FROM usage u JOIN framework_calls c ON c.reservation_id=u.id WHERE c.request_id=?',
      )
      .get('request'),
  ).toMatchObject({ status: 'unknown', charged_nanos: null });
  expect(
    store.db
      .prepare(
        'SELECT p.error_code FROM provider_usage p JOIN framework_calls c ON c.reservation_id=p.reservation_id WHERE c.request_id=?',
      )
      .get('request')?.error_code,
  ).toBe('PROCESS_INTERRUPTED');
  expect(
    store.db
      .prepare(
        'SELECT u.status,u.input_tokens FROM usage u JOIN framework_calls c ON c.reservation_id=u.id WHERE c.request_id=?',
      )
      .get('complete'),
  ).toMatchObject({ status: 'settled', input_tokens: 10 });
});
