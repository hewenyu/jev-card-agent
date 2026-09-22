import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeStore, baselineSnapshot } from '../src/knowledge/store.js';
import { KnowledgeValidator, snapshotHash } from '../src/knowledge/validator.js';
import { ResearchQueue } from '../src/research/queue.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/storage/store.js';

describe('versioned background reads', () => {
  it('validates unchanged knowledge once while observing expiry and external writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-read-cache-'));
    const filename = join(dir, 'knowledge.sqlite');
    const writer = new KnowledgeStore(filename);
    const reader = new KnowledgeStore(filename, { readOnly: true });
    const { contentHash: _old, ...base } = baselineSnapshot();
    const content = {
      ...base,
      source: 'deterministic' as const,
      version: 'v1',
      evidenceEventId: 1,
      evidenceCutoff: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-02T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
    };
    const validator = vi.spyOn(KnowledgeValidator.prototype, 'validate');
    try {
      writer.publish({ ...content, contentHash: snapshotHash(content) });
      validator.mockClear();
      const first = reader.latest('2026-01-03T00:00:00.000Z');
      first.cards.splice(0);
      expect(reader.latest('2026-01-03T00:00:01.000Z').cards.length).toBeGreaterThan(0);
      expect(validator).toHaveBeenCalledTimes(1);
      expect(reader.latest('2026-01-04T00:00:00.000Z').source).toBe('baseline');
      expect(reader.latest('2026-01-01T00:00:00.000Z').source).toBe('baseline');
      const next = { ...content, version: 'v2', evidenceEventId: 2 };
      writer.publish({ ...next, contentHash: snapshotHash(next) });
      expect(reader.latest('2026-01-03T00:00:00.000Z').version).toBe('v2');
      writer.db.prepare('UPDATE knowledge_versions SET payload=? WHERE version=?').run('{}', 'v2');
      expect(() => reader.latest('2026-01-03T00:00:00.000Z')).toThrow();
    } finally {
      validator.mockRestore();
      reader.close();
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses research aggregates until a same-connection or external write occurs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-read-cache-'));
    const path = join(dir, 'research.sqlite');
    const queue = new ResearchQueue(path);
    const writer = new ResearchQueue(path);
    const entries = vi.spyOn(queue.scheduler, 'entries');
    try {
      expect(queue.status().attempts).toBe(0);
      queue.status();
      expect(entries).toHaveBeenCalledTimes(1);
      writer.db.exec(`INSERT INTO research_attempts
        (id,job_id,generation,started_at,status,call) VALUES('a','job',0,'2026-01-01','started','{}')`);
      expect(queue.status().attempts).toBe(1);
      expect(entries).toHaveBeenCalledTimes(2);
      queue.db.exec("UPDATE research_attempts SET cost_usd=0.1 WHERE id='a'");
      expect(queue.status().costUsd).toBe(0.1);
      expect(entries).toHaveBeenCalledTimes(3);
      queue.status();
      expect(entries).toHaveBeenCalledTimes(3);
      queue.db.exec('BEGIN');
      queue.db.exec(`INSERT INTO research_attempts
        (id,job_id,generation,started_at,status,call) VALUES('rolled-back','job',0,'2026-01-01','started','{}')`);
      expect(queue.status().attempts).toBe(2);
      queue.db.exec('ROLLBACK');
      expect(queue.status().attempts).toBe(1);
    } finally {
      entries.mockRestore();
      queue.close();
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('coalesces progress bursts instead of blocking each worker callback with a refresh', async () => {
    const store = new Store(':memory:');
    const app = await buildApp(loadConfig({}, true), { store });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const refresh = vi.spyOn(store, 'refreshKnowledge');
    try {
      for (let i = 0; i < 100; i++) {
        app.controller.research.emit('update');
        app.controller.asyncResearch.emit('update');
      }
      expect(refresh).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(refresh).toHaveBeenCalledTimes(1);
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      refresh.mockRestore();
      await app.close();
      store.close();
    }
  });
});
