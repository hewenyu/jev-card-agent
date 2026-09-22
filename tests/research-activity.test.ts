import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { researchActivity, ResearchActivityCounter } from '../src/server/research-activity.js';

describe('research activity periods', () => {
  it('separates calls, retries and insufficient outcomes by run time, and adoption by run identity', () => {
    const raw = new DatabaseSync(':memory:');
    const research = new DatabaseSync(':memory:');
    raw.exec(`CREATE TABLE runs(id TEXT,mode TEXT,started_at TEXT,ended_at TEXT);
      INSERT INTO runs VALUES('old','live','2026-09-22T08:00:00Z','2026-09-22T09:00:00Z');
      INSERT INTO runs VALUES('new','live','2026-09-22T10:00:00Z','2026-09-22T11:00:00Z');
      INSERT INTO runs VALUES('demo','demo','2026-09-22T12:00:00Z',NULL);`);
    research.exec(`CREATE TABLE research_attempts(started_at TEXT,status TEXT,attempt TEXT);
      CREATE TABLE research_jobs(completed_at TEXT,state TEXT,outcome TEXT);`);
    const attempt = research.prepare('INSERT INTO research_attempts VALUES(?,?,?)');
    attempt.run('2026-09-22T09:59:59Z', 'succeeded', '{"retryIndex":0}');
    attempt.run('2026-09-22T10:00:00Z', 'failed', '{"retryIndex":0}');
    attempt.run('2026-09-22T10:00:02Z', 'succeeded', '{"retryIndex":1}');
    attempt.run('2026-09-22T11:00:01Z', 'started', null);
    attempt.run('2026-09-22T10:00:04Z', 'model_mismatch', '{"retryIndex":0}');
    attempt.run('2026-09-22T10:00:05Z', 'cancelled', '{"retryIndex":0}');
    const job = research.prepare('INSERT INTO research_jobs VALUES(?,?,?)');
    job.run('2026-09-22T09:59:59Z', 'completed', '{"insufficient":false}');
    job.run('2026-09-22T10:00:03Z', 'completed', '{"insufficient":true}');
    job.run('2026-09-22T10:01:00Z', 'failed', '{}');
    job.run('2026-09-22T11:00:01Z', 'completed', '{"insufficient":false}');
    try {
      const result = researchActivity(
        raw,
        research,
        { evaluated: 12, adopted: 7, unmatched: 4 },
        new Map([['new', { evaluated: 3, adopted: 2, unmatched: 1 }]]),
        true,
      );
      expect(result.currentRun).toMatchObject({
        id: 'new',
        attempts: 4,
        retries: 1,
        successfulAttempts: 1,
        failedAttempts: 3,
        completedJobs: 1,
        insufficientJobs: 1,
        evaluatedDecisions: 3,
        adoptedDecisions: 2,
      });
      expect(result.allTime).toEqual({
        attempts: 6,
        retries: 1,
        successfulAttempts: 2,
        failedAttempts: 3,
        completedJobs: 3,
        insufficientJobs: 1,
        evaluatedDecisions: 12,
        adoptedDecisions: 7,
        unmatchedDecisions: 4,
      });
      raw.exec("INSERT INTO runs VALUES('restarted','live','2026-09-22T11:00:01Z',NULL)");
      const restarted = researchActivity(
        raw,
        research,
        { evaluated: 12, adopted: 7, unmatched: 4 },
        new Map(),
        false,
      );
      expect(restarted.currentRun).toMatchObject({
        id: 'restarted',
        attempts: 1,
        adoptedDecisions: 0,
      });
      expect(restarted.decisionsCaughtUp).toBe(false);
      expect(
        researchActivity(raw, null, { evaluated: 0, adopted: 0, unmatched: 0 }, new Map(), true)
          .currentRun?.attempts,
      ).toBe(0);
    } finally {
      research.close();
      raw.close();
    }
  });
  it('caches ledger aggregation for 15 seconds but refreshes decisions, run switches and boundaries immediately', () => {
    const raw = new DatabaseSync(':memory:');
    const research = new DatabaseSync(':memory:');
    let clock = 1000;
    const counter = new ResearchActivityCounter(() => clock);
    raw.exec(`CREATE TABLE runs(id TEXT,mode TEXT,started_at TEXT,ended_at TEXT);
      INSERT INTO runs VALUES('first','live','2026-09-22T10:00:00Z',NULL);`);
    research.exec(`CREATE TABLE research_attempts(started_at TEXT,status TEXT,attempt TEXT);
      CREATE TABLE research_jobs(completed_at TEXT,state TEXT,outcome TEXT);
      INSERT INTO research_attempts VALUES('2026-09-22T10:00:01Z','succeeded','{"retryIndex":0}');`);
    const decisions = { evaluated: 1, adopted: 1, unmatched: 0 };
    const byRun = new Map([['first', decisions]]);
    const read = (cache = counter, source: DatabaseSync | null = research) =>
      researchActivity(raw, source, decisions, byRun, true, cache);
    try {
      expect(read().currentRun?.attempts).toBe(1);
      research.exec(`INSERT INTO research_attempts VALUES('2026-09-22T10:00:02Z','succeeded','{"retryIndex":0}');
        INSERT INTO research_jobs VALUES('2026-09-22T10:00:03Z','completed','{"insufficient":true}');`);
      decisions.evaluated = 3;
      decisions.adopted = 2;
      clock += 14999;
      expect(read().currentRun).toMatchObject({
        attempts: 1,
        completedJobs: 0,
        evaluatedDecisions: 3,
        adoptedDecisions: 2,
      });
      // Cache belongs to one monitor: another newly created monitor sees its own current ledger.
      expect(read(new ResearchActivityCounter(() => clock)).allTime.attempts).toBe(2);
      clock++;
      expect(read().currentRun).toMatchObject({
        attempts: 2,
        completedJobs: 1,
        insufficientJobs: 1,
      });
      research.exec(
        `INSERT INTO research_attempts VALUES('2026-09-22T11:00:01Z','succeeded','{"retryIndex":0}');`,
      );
      raw.exec(`INSERT INTO runs VALUES('second','live','2026-09-22T11:00:00Z',NULL);`);
      const switched = read();
      expect(switched.allTime.attempts).toBe(3);
      expect(switched.currentRun).toMatchObject({
        id: 'second',
        attempts: 1,
        evaluatedDecisions: 0,
      });
      // Recording the stop boundary excludes activity outside the run without waiting for cache expiry.
      raw.exec(`UPDATE runs SET ended_at='2026-09-22T11:00:00Z' WHERE id='second';`);
      expect(read().currentRun?.attempts).toBe(0);
      const offline = new ResearchActivityCounter(() => clock);
      expect(read(offline, null).allTime.attempts).toBe(0);
      expect(read(offline, research).allTime.attempts).toBe(3);
    } finally {
      research.close();
      raw.close();
    }
  });
});
