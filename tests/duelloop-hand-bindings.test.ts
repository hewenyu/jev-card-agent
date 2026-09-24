import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from 'duelloop';
import { HandBindings } from '../src/duelloop/live/bindings.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { activateNext, hostFixture } from './helpers/duelloop-fixture.js';

const fixtures: ReturnType<typeof hostFixture>[] = [],
  directories: string[] = [];
const fixture = (options: Parameters<typeof hostFixture>[0] = {}) => {
  const value = hostFixture(options);
  fixtures.push(value);
  return value;
};
const rebind = (f: ReturnType<typeof hostFixture>, latest = baselineSnapshot) =>
  new HandBindings(f.journal, f.runtime, f.bindings.scopeId, 'hero-id', latest);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) await value.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('hand facts and release binding recovery', () => {
  it('pins once per table/hand and does not mutate the stored or cached snapshot through a returned value', async () => {
    const f = fixture(),
      at = new Date().toISOString();
    const first = f.bindings.pin(f.state, at);
    first.facts.source = 'tampered-client-copy';
    const original = f.bindings.pin(f.state, at);
    expect(original.facts.source).toBe(baselineSnapshot().version);
    const next = await activateNext(f);
    expect(f.bindings.pin(f.state, at).releaseDigest).toBe(original.releaseDigest);
    expect(rebind(f).pin(f.state, at).releaseDigest).toBe(original.releaseDigest);
    expect(f.bindings.pin({ ...f.state, handId: 'next-hand' }, at).releaseDigest).toBe(next);
    expect(f.bindings.pin({ ...f.state, tableId: 'other-table' }, at).trajectoryId).not.toBe(
      original.trajectoryId,
    );
  });

  it('recovers raw facts written before SDK pin without loading newer statistics', () => {
    const f = fixture(),
      at = new Date().toISOString();
    const failure = vi.spyOn(f.runtime, 'pinTrajectory').mockImplementationOnce(() => {
      throw new Error('crash before SDK pin');
    });
    expect(() => f.bindings.pin(f.state, at)).toThrow('crash before SDK pin');
    failure.mockRestore();
    const row = f.raw.db.prepare('SELECT * FROM framework_hands').get()!;
    expect(row.release).toBeNull();
    expect(row.expected_release).toBe(f.sdk.activeRelease(f.bindings.scopeId));
    const latest = vi.fn(() => {
      throw new Error('new facts must not be read');
    });
    const recovered = rebind(f, latest).pin(f.state, new Date(Date.parse(at) + 1000).toISOString());
    expect(recovered.factsSnapshotDigest).toBe(row.facts_digest);
    expect(recovered.pinnedAt).toBe(at);
    expect(latest).not.toHaveBeenCalled();
  });

  it('refuses to bind an old hand to a new release after raw-facts-only crash', async () => {
    const f = fixture(),
      at = new Date().toISOString();
    const failure = vi.spyOn(f.runtime, 'pinTrajectory').mockImplementationOnce(() => {
      throw new Error('crash');
    });
    expect(() => f.bindings.pin(f.state, at)).toThrow('crash');
    failure.mockRestore();
    await activateNext(f);
    expect(() => rebind(f).pin(f.state, at)).toThrow('Original hand strategy release');
    const identity = f.bindings.identity(f.state);
    expect(
      f.runtime.lookupTrajectoryRelease({ ...identity, strategyScopeId: identity.scopeId }),
    ).toBeUndefined();
  });

  it('links an SDK pin after the raw release-link transaction was interrupted', () => {
    const f = fixture(),
      at = new Date().toISOString();
    f.raw.db.exec(
      "CREATE TRIGGER fail_binding_link BEFORE UPDATE OF release ON framework_hands BEGIN SELECT RAISE(ABORT,'crash linking release'); END",
    );
    expect(() => f.bindings.pin(f.state, at)).toThrow('crash linking release');
    const identity = f.bindings.identity(f.state);
    const sdkPin = f.runtime.lookupTrajectoryRelease({
      ...identity,
      strategyScopeId: identity.scopeId,
    });
    expect(sdkPin).toBeTruthy();
    expect(f.raw.db.prepare('SELECT release FROM framework_hands').get()?.release).toBeNull();
    f.raw.db.exec('DROP TRIGGER fail_binding_link');
    expect(rebind(f).pin(f.state, at).releaseDigest).toBe(sdkPin);
  });

  it('does not manufacture original facts when SDK pin exists without the host snapshot', () => {
    const f = fixture(),
      identity = f.bindings.identity(f.state);
    f.runtime.pinTrajectory({ ...identity, strategyScopeId: identity.scopeId });
    const latest = vi.fn(baselineSnapshot);
    expect(() => rebind(f, latest).pin(f.state, new Date().toISOString())).toThrow(
      'no recoverable original facts',
    );
    expect(latest).not.toHaveBeenCalled();
    expect(f.raw.db.prepare('SELECT COUNT(*) n FROM framework_hands').get()?.n).toBe(0);
  });

  it('preserves hand release and exact facts across both databases reopening', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'duelloop-hand-binding-'));
    directories.push(directory);
    const paths = {
      rawPath: join(directory, 'raw.sqlite'),
      sdkPath: join(directory, 'sdk.sqlite'),
    };
    const f = fixture(paths),
      at = new Date().toISOString(),
      original = f.bindings.pin(f.state, at);
    await activateNext(f);
    fixtures.splice(fixtures.indexOf(f), 1);
    await f.close();
    const reopened = fixture({
      ...paths,
      facts: () => {
        throw new Error('old hand must keep its facts');
      },
    });
    expect(reopened.bindings.pin(reopened.state, new Date().toISOString())).toEqual(original);
  });

  it('refuses corrupt facts and a raw link that has lost its SDK pin', () => {
    const f = fixture(),
      at = new Date().toISOString();
    f.bindings.pin(f.state, at);
    f.raw.db
      .prepare('UPDATE framework_hands SET facts=?')
      .run(JSON.stringify({ ...baselineSnapshot(), schema: 'poker-facts-v1' }));
    expect(() => rebind(f).pin(f.state, at)).toThrow('digest mismatch');
    const another = fixture();
    another.bindings.pin(another.state, at);
    vi.spyOn(another.runtime, 'lookupTrajectoryRelease').mockReturnValue(undefined);
    const pin = vi.spyOn(another.runtime, 'pinTrajectory');
    expect(() => rebind(another).pin(another.state, at)).toThrow('lost their SDK release');
    expect(pin).not.toHaveBeenCalled();
  });

  it('rejects invalid timestamps and future evidence or publication before writing a pin', () => {
    const at = '2026-09-24T00:00:00.000Z';
    for (const change of [
      { evidenceCutoff: 'invalid' },
      { publishedAt: 'invalid' },
      { evidenceCutoff: '2026-09-25T00:00:00.000Z' },
      { publishedAt: '2026-09-25T00:00:00.000Z' },
    ]) {
      const f = fixture({ facts: () => ({ ...baselineSnapshot(), ...change }) });
      expect(() => f.bindings.pin(f.state, at)).toThrow();
      expect(f.raw.db.prepare('SELECT COUNT(*) n FROM framework_hands').get()?.n).toBe(0);
    }
    const f = fixture();
    expect(() => f.bindings.pin(f.state, 'not-a-time')).toThrow('time is invalid');
  });

  it('revalidates persisted time boundaries even if a corrupted snapshot has a matching recomputed digest', () => {
    const f = fixture(),
      at = '2026-09-24T00:00:00.000Z';
    const binding = f.bindings.pin(f.state, at);
    const future = { ...binding.facts, cutoff: '2026-09-25T00:00:00.000Z' };
    f.raw.db
      .prepare('UPDATE framework_hands SET facts=?,facts_digest=?')
      .run(JSON.stringify(future), digest(future));
    expect(() => rebind(f).pin(f.state, at)).toThrow('time boundary');
  });
});
