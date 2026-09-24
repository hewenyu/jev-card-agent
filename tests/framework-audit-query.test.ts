import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/storage/store.js';
import { Queries } from '../src/storage/queries.js';
import { FactsWorker } from '../src/facts/worker.js';
import { FactsService } from '../src/facts/service.js';
import { buildContext, createInitialState } from '../src/core/index.js';

describe('framework facts audit history refresh', () => {
  it('returns a newly completed separate-store audit without changing archived framework input', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'framework-audit-query-'));
    const rawPath = join(directory, 'raw.sqlite');
    const factsPath = join(directory, 'facts.sqlite');
    const store = new Store(rawPath);
    const worker = new FactsWorker(rawPath, factsPath, 10);
    // Start only the real read connection. Materialize deterministically between the two reads.
    const service = new FactsService(rawPath, factsPath, { enabled: false });
    try {
      await service.start();
      store.knowledgeSource = service;
      store.beginRun({
        id: 'run',
        kind: 'live',
        strategy: 'jev',
        startedAt: '2026-01-01',
        config: {},
      });
      const state = {
        ...createInitialState(),
        tableId: 'table',
        handId: 'hand',
        heroSeat: 0,
        holeCards: ['Ah', 'Ad'],
        board: ['2c', '3c', '8d', '9h', 'Js'],
        seats: [
          { seat: 0, name: 'hero', stack: 1000, bet: 0, status: 'active' },
          { seat: 1, name: 'villain', stack: 1000, bet: 0, status: 'active' },
        ],
      };
      const context = buildContext(state);
      context.framework = {
        engine: 'duelloop',
        releaseDigest: 'release',
        factsSnapshotDigest: 'facts',
        evidenceCutoff: '2026-01-01T00:00:00.000Z',
      };
      store.saveDecision({
        id: 'decision',
        runId: 'run',
        handId: 'hand',
        createdAt: '2026-01-01',
        context,
        candidates: [{ id: 'check', action: 'check', label: 'Check' }],
        proposal: {
          source: 'jev',
          candidateId: 'check',
          selected: 'check',
          explanation: 'Stored model decision',
          latencyMs: 1,
        },
        fallbackReason: null,
      });
      const original = store.db
        .prepare('SELECT context FROM decisions WHERE id=?')
        .get('decision')!.context;
      const queries = new Queries(store);
      expect(queries.decision('decision')!.knowledge).toBeUndefined();
      expect(queries.decision('decision')!.audit?.status).toBe('disabled');
      expect(queries.handAudits('hand')[0]!.audit?.status).toBe('disabled');
      worker.tick();
      const completed = queries.decision('decision')!.audit!;
      expect(completed.status).toBe('complete');
      expect(completed.uniformShowdownReference).not.toBeNull();
      expect(completed.provenance).toBe('asynchronous_audit_not_model_input');
      expect(queries.handAudits('hand')).toEqual([{ decisionId: 'decision', audit: completed }]);
      expect(
        store.db.prepare('SELECT context FROM decisions WHERE id=?').get('decision')!.context,
      ).toBe(original);
    } finally {
      await service.stop();
      worker.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
