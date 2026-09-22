import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';
import { baselineSnapshot } from '../src/knowledge/store.js';
import { snapshotHash } from '../src/knowledge/validator.js';
import { hashAdviceBundle } from '../src/knowledge/advice-validator.js';
import { emptyAdviceBundle } from '../src/knowledge/advice-selector.js';
import type { KnowledgeSnapshot } from '../src/knowledge/types.js';
import type { OpponentMemory } from '../src/core/opponent-memory.js';
import type { AdviceBundle } from '../src/knowledge/advice-types.js';
import { createInitialState } from '../src/core/state.js';

function largeSnapshot(): KnowledgeSnapshot {
  const now = Date.now();
  const before = new Date(now - 60_000).toISOString();
  const cutoff = new Date(now - 1000).toISOString();
  const street = {
    observedActions: 1,
    raises: 0,
    calls: 1,
    checks: 0,
    folds: 0,
    allIns: 0,
    facedBetObserved: 1,
    foldedToObservedBet: 0,
    sizedContributions: 1,
    contributionToPotSum: 0.5,
  };
  const opponents: OpponentMemory[] = Array.from({ length: 256 }, (_, index) => ({
    version: 'completed-opponent-encounters-v1',
    name: `observed-${index}`,
    asOf: cutoff,
    sampledHands: 1,
    sampleLimit: 200,
    sampleCapped: false,
    firstCompletedAt: before,
    lastCompletedAt: before,
    shownHands: 0,
    streets: { preflop: street, flop: street, turn: street, river: street },
    showdowns: [],
    recentEncountersWithHero: [],
    caveats: ['Controlled large evidence fixture. ' + 'x'.repeat(16000)],
  }));
  const { contentHash: _old, ...base } = baselineSnapshot();
  const content = {
    ...base,
    version: 'large-e1',
    source: 'deterministic' as const,
    evidenceEventId: 1,
    evidenceCutoff: cutoff,
    publishedAt: cutoff,
    opponents,
  };
  return { ...content, contentHash: snapshotHash(content) };
}
function withHash(bundle: AdviceBundle): AdviceBundle {
  return { ...bundle, bundleHash: hashAdviceBundle(bundle) };
}

describe('bounded publication refresh on the actual Controller path', () => {
  it('does not repeatedly serialize unchanged large statistics; changed support, mode and facts archive before future pins', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(loadConfig({}, true), { store });
    const snapshot = largeSnapshot();
    let currentSnapshot = snapshot;
    let bundle = emptyAdviceBundle('off', baselineSnapshot().version);
    const sizes = Buffer.byteLength(JSON.stringify(snapshot));
    vi.spyOn(app.controller.research, 'latest').mockImplementation(() => currentSnapshot);
    vi.spyOn(app.controller.asyncResearch, 'mode').mockImplementation(() => bundle.mode);
    vi.spyOn(app.controller.asyncResearch, 'bundle').mockImplementation(() => bundle);
    const refresh = () => app.controller.asyncResearch.emit('update');
    const count = () =>
      Number(store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_archive_publications').get()!.n);
    const before = count();
    const started = performance.now();
    refresh();
    const firstMs = performance.now() - started;
    expect(count()).toBe(before + 1);
    const stringify = vi.spyOn(JSON, 'stringify');
    const durations: number[] = [];
    try {
      for (let index = 0; index < 60; index++) {
        const start = performance.now();
        refresh();
        durations.push(performance.now() - start);
      }
      expect(count()).toBe(before + 1);
      expect(
        stringify.mock.calls.some(
          ([value]) =>
            typeof value === 'object' &&
            value !== null &&
            (('snapshot' in value && value.snapshot === snapshot) ||
              ('opponents' in value && value.opponents === snapshot.opponents)),
        ),
      ).toBe(false);
      stringify.mockRestore();
      store.beginRun({
        id: 'run',
        kind: 'live',
        strategy: 'jev',
        startedAt: new Date().toISOString(),
        config: {},
      });
      const at = new Date().toISOString();
      store.appendEvent(
        'run',
        { type: 'hand_start', table_id: 'table', hand_id: 'hand', ts: at },
        at,
      );
      const state = { ...createInitialState(), tableId: 'table', handId: 'hand', heroSeat: 0 };
      const pin = store.pinKnowledge(state, at);
      bundle = withHash({
        ...emptyAdviceBundle('shadow', baselineSnapshot().version),
        maxItems: 3,
      });
      refresh();
      expect(count()).toBe(before + 2);
      bundle = withHash({
        ...bundle,
        availableAt: new Date().toISOString(),
        supportMetrics: [
          {
            id: 'entry',
            name: 'Entry',
            numerator: 1,
            denominator: 1,
            handIds: ['prior'],
            throughEventId: 2,
            availableAt: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      });
      refresh();
      expect(count()).toBe(before + 3);
      const { contentHash: _old, ...content } = snapshot;
      const next = { ...content, version: 'large-e2', evidenceEventId: 2 };
      currentSnapshot = { ...next, contentHash: snapshotHash(next) };
      refresh();
      expect(count()).toBe(before + 4);
      expect(store.pinKnowledge(state, new Date().toISOString())).toBe(pin);
      expect(pin.pin.asyncLlmMode).toBe('off');
      expect(pin.snapshot.contentHash).toBe(snapshot.contentHash);
      const destination = process.env.ASYNC_ARCHIVE_PERFORMANCE_OUTPUT;
      if (destination) {
        const sorted = [...durations].sort((a, b) => a - b);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(
          destination,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              environment: {
                platform: platform(),
                release: release(),
                cpu: cpus()[0]?.model,
                node: process.version,
              },
              snapshotBytes: sizes,
              opponents: 256,
              firstArchiveMs: firstMs,
              unchangedControllerRefresh: {
                samples: durations.length,
                p50: sorted[29],
                p95: sorted[56],
                p99: sorted[59],
                rawMs: durations,
              },
              limitations: [
                'Controlled in-memory SQLite Controller; real immutable archive SQL/validation/hash path executes.',
                'Source services return fixed synthetic snapshots; real provider/database read time is excluded.',
                'Initial changed archive cost remains synchronous and measured separately; this is not production P95.',
                'No real Arena or paid API calls.',
              ],
            },
            null,
            2,
          ),
        );
      }
    } finally {
      stringify.mockRestore();
      await app.close();
      store.close();
    }
  });
});
