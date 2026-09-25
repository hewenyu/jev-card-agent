import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostFixture } from './helpers/duelloop-fixture.js';

const fixtures: ReturnType<typeof hostFixture>[] = [];
const fixture = () => {
  const f = hostFixture();
  fixtures.push(f);
  return f;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
const result = (end = 540) => ({
  type: 'hand_result',
  table_id: 'table',
  hand_id: 'hand',
  ts: '2026-09-25T01:00:01Z',
  final_stacks: { '0': end },
});
const start = (f: ReturnType<typeof hostFixture>) => {
  f.state.handStartStacks = { '0': 500, '1': 500 };
  f.bridge.store.saveHand('fixture-run', f.state, {
    type: 'hand_start',
    ts: '2026-09-25T01:00:00Z',
  });
};
const count = (f: ReturnType<typeof hostFixture>) =>
  Number(f.raw.db.prepare('SELECT count(*) n FROM framework_deferred_feedback').get()!.n);
const pin = (f: ReturnType<typeof hostFixture>) => f.bindings.pin(f.state, '2026-09-25T01:00:00Z');

describe('durable settlement waiting for async hand binding', () => {
  it('preserves result before pin and submits the original metrics and time after pin without a model request', async () => {
    const f = fixture();
    start(f);
    f.bridge.store.saveHand('fixture-run', f.state, result());
    expect(count(f)).toBe(1);
    await f.bridge.flush();
    expect(f.sdk.latestFeedback(f.bindings.scopeId)).toHaveLength(0);
    expect(f.raw.db.prepare('SELECT count(*) n FROM framework_hands').get()!.n).toBe(0);
    const original = JSON.parse(
      String(f.raw.db.prepare('SELECT payload FROM framework_deferred_feedback').get()!.payload),
    );
    pin(f);
    f.bridge.reconcileFeedback();
    expect(count(f)).toBe(0);
    await f.bridge.flush();
    expect(f.sdk.latestFeedback(f.bindings.scopeId)[0]?.feedback).toEqual(original.feedback);
    expect(original.feedback).toMatchObject({
      revision: 1,
      metrics: { netChips: 40, netBb: 2 },
      eventTime: Date.parse(result().ts),
    });
    expect(f.modelCalls()).toBe(0);
  });

  it('recovers pending settlements after closing and reopening both real stores', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-deferred-'));
    const options = {
      rawPath: join(directory, 'raw.sqlite'),
      sdkPath: join(directory, 'sdk.sqlite'),
    };
    let f = hostFixture(options);
    try {
      start(f);
      f.bridge.store.saveHand('fixture-run', f.state, result());
      // Pin can finish after the settlement is captured, then a restart occurs before flush.
      pin(f);
      await f.close();
      f = hostFixture(options);
      expect(count(f)).toBe(1);
      await f.bridge.flush();
      expect(count(f)).toBe(0);
      expect(f.sdk.latestFeedback(f.bindings.scopeId)[0]?.feedback.metrics).toEqual({
        netChips: 40,
        netBb: 2,
      });
      expect(f.modelCalls()).toBe(0);
    } finally {
      await f.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('deduplicates repeats and preserves correction revisions without adding first settlements', async () => {
    const f = fixture();
    start(f);
    f.bridge.store.saveHand('fixture-run', f.state, result());
    f.bridge.store.saveHand('fixture-run', f.state, result());
    f.bridge.store.saveHand('fixture-run', f.state, result(520));
    expect(count(f)).toBe(2);
    pin(f);
    await f.bridge.flush();
    expect(f.sdk.latestFeedback(f.bindings.scopeId)[0]?.feedback).toMatchObject({
      revision: 2,
      metrics: { netChips: 20, netBb: 1 },
    });
    expect(
      f.sdk.feedbackProgress(f.bindings.scopeId, 0, 'first_settlement').settledTrajectories,
    ).toBe(1);
    f.bridge.store.saveHand('fixture-run', f.state, result(520));
    await f.bridge.flush();
    expect(f.sdk.events({ types: ['feedback.received'] })).toHaveLength(2);
    f.bridge.store.saveHand('fixture-run', f.state, result(500));
    await f.bridge.flush();
    expect(f.sdk.latestFeedback(f.bindings.scopeId)[0]?.feedback.revision).toBe(3);
    expect(
      f.sdk.feedbackProgress(f.bindings.scopeId, 0, 'first_settlement').settledTrajectories,
    ).toBe(1);
  });

  it('keeps partial hand bindings pending until the original host and SDK release agree', async () => {
    const f = fixture();
    start(f);
    const binding = pin(f);
    f.raw.db.prepare('UPDATE framework_hands SET release=NULL').run();
    f.bridge.store.saveHand('fixture-run', f.state, result());
    await f.bridge.flush();
    expect(count(f)).toBe(1);
    expect(f.sdk.latestFeedback(f.bindings.scopeId)).toHaveLength(0);
    f.raw.db.prepare('UPDATE framework_hands SET release=?').run(binding.releaseDigest);
    await f.bridge.flush();
    expect(count(f)).toBe(0);
    expect(f.sdk.latestFeedback(f.bindings.scopeId)).toHaveLength(1);
  });

  it('does not let unbound historical settlements hide a later fully bound settlement', async () => {
    const f = fixture();
    for (let index = 0; index < 110; index++) {
      f.state.handId = `old-${index}`;
      start(f);
      f.bridge.store.saveHand('fixture-run', f.state, { ...result(), hand_id: f.state.handId });
    }
    f.state.handId = 'hand';
    start(f);
    pin(f);
    f.bridge.store.saveHand('fixture-run', f.state, result());
    await f.bridge.flush();
    expect(count(f)).toBe(110);
    expect(f.sdk.latestFeedback(f.bindings.scopeId)).toHaveLength(1);
    expect(f.sdk.latestFeedback(f.bindings.scopeId)[0]?.feedback.trajectoryId).toBe(
      JSON.stringify(['table', 'hand']),
    );
  });

  it('rolls back saveHand when durable deferred insertion fails', () => {
    const f = fixture();
    start(f);
    f.raw.db.exec(
      `CREATE TRIGGER fixture_fail_feedback BEFORE INSERT ON framework_deferred_feedback BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;`,
    );
    expect(() => f.bridge.store.saveHand('fixture-run', f.state, result())).toThrow(
      'fixture storage failure',
    );
    expect(
      f.raw.db.prepare('SELECT complete,profit FROM hands WHERE id=?').get('hand'),
    ).toMatchObject({ complete: 0, profit: null });
    expect(count(f)).toBe(0);
    expect(f.raw.db.prepare('SELECT count(*) n FROM framework_feedback').get()!.n).toBe(0);
  });

  it('preserves deferred evidence if enqueue fails and retries SDK delivery idempotently', async () => {
    const f = fixture();
    start(f);
    pin(f);
    f.bridge.store.saveHand('fixture-run', f.state, result());
    vi.spyOn(f.journal, 'enqueue').mockImplementationOnce(() => {
      throw new Error('outbox failure');
    });
    await expect(f.bridge.flush()).rejects.toThrow('outbox failure');
    expect(count(f)).toBe(1);
    vi.spyOn(f.journal, 'delivered').mockImplementationOnce(() => {
      throw new Error('marker failure');
    });
    await expect(f.bridge.flush()).rejects.toThrow('marker failure');
    expect(count(f)).toBe(0);
    expect(f.journal.pending('feedback')).toHaveLength(1);
    await f.bridge.flush();
    expect(f.sdk.events({ types: ['feedback.received'] })).toHaveLength(1);
    expect(f.journal.pending('feedback')).toHaveLength(0);
  });

  it('does not manufacture old bindings or accept conflicting original facts and releases', async () => {
    const f = fixture();
    start(f);
    f.bridge.store.saveHand('fixture-run', f.state, result());
    const getFacts = vi.spyOn(f.bindings, 'pin');
    await f.bridge.flush();
    expect(getFacts).not.toHaveBeenCalled();
    const binding = pin(f);
    f.raw.db.prepare('UPDATE framework_hands SET facts_digest=?').run('bad-facts');
    await expect(f.bridge.flush()).rejects.toThrow('facts binding');
    expect(count(f)).toBe(1);
    f.raw.db
      .prepare('UPDATE framework_hands SET facts_digest=?,release=?')
      .run(binding.factsSnapshotDigest, 'bad-release');
    await expect(f.bridge.flush()).rejects.toThrow('strategy binding conflict');
    expect(f.sdk.latestFeedback(f.bindings.scopeId)).toHaveLength(0);
  });
});
