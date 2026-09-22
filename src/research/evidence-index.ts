import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { opponentKey } from '../knowledge/advice-validator.js';

type Row = Record<string, unknown>;
const object = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
function parse(v: unknown): Row {
  try {
    return object(JSON.parse(String(v)));
  } catch {
    return {};
  }
}
/** Untrusted locators only. Every returned hand is reloaded and attributed from the raw archive. */
export class EvidenceIndex {
  private readonly db: DatabaseSync;
  constructor(
    private readonly raw: DatabaseSync,
    rawPath: string,
    indexPath?: string,
  ) {
    const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
    if (indexPath && canonical(indexPath) === canonical(rawPath))
      throw new Error('research_index_must_be_separate');
    // CLI/offline fallback is entirely in memory; it never changes the raw database.
    this.db = new DatabaseSync(indexPath ?? ':memory:');
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS research_hand_locators (
        run_id TEXT NOT NULL, hand_id TEXT NOT NULL, opponent_key TEXT NOT NULL,
        event_id INTEGER NOT NULL, PRIMARY KEY(run_id,hand_id,opponent_key));
      CREATE INDEX IF NOT EXISTS research_locator_opponent ON research_hand_locators(opponent_key,event_id DESC);
      CREATE TABLE IF NOT EXISTS research_locator_cursor (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), source TEXT NOT NULL,
        event_id INTEGER NOT NULL, decision_rowid INTEGER NOT NULL);`);
    const old = this.db.prepare('SELECT * FROM research_locator_cursor WHERE singleton=1').get();
    if (!old || old.source !== resolve(rawPath)) {
      this.db.exec('DELETE FROM research_hand_locators; DELETE FROM research_locator_cursor');
      this.db.prepare('INSERT INTO research_locator_cursor VALUES(1,?,0,0)').run(resolve(rawPath));
    }
  }
  sync(): void {
    const cursor = this.db
      .prepare('SELECT * FROM research_locator_cursor WHERE singleton=1')
      .get()!;
    const eventMax = Number(
      this.raw.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events').get()!.n,
    );
    const decisionMax = Number(
      this.raw.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM decisions').get()!.n,
    );
    // Raw history replacement is not a continuation of the previous index.
    if (eventMax < Number(cursor.event_id) || decisionMax < Number(cursor.decision_rowid)) {
      this.db.exec(
        'DELETE FROM research_hand_locators; UPDATE research_locator_cursor SET event_id=0,decision_rowid=0',
      );
      return this.sync();
    }
    const changed = this.raw
      .prepare(
        `SELECT DISTINCT run_id,hand_id FROM events WHERE id>? AND id<=? AND hand_id IS NOT NULL
      UNION SELECT DISTINCT run_id,hand_id FROM decisions WHERE rowid>? AND rowid<=?`,
      )
      .all(Number(cursor.event_id), eventMax, Number(cursor.decision_rowid), decisionMax);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare(
        'DELETE FROM research_hand_locators WHERE run_id=? AND hand_id=?',
      );
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO research_hand_locators VALUES(?,?,?,?)',
      );
      for (const row of changed) {
        const run = String(row.run_id),
          hand = String(row.hand_id);
        const keys = new Set<string>();
        const observe = (record: Row) => {
          const seats = Array.isArray(record.seats) ? record.seats : [];
          for (const seat of [...seats, record]) {
            const name = object(seat).name;
            if (typeof name === 'string' && name) keys.add(opponentKey(name));
          }
        };
        const events = this.raw
          .prepare(`SELECT id,type,payload FROM events WHERE run_id=? AND hand_id=? ORDER BY id`)
          .all(run, hand);
        for (const event of events) observe(parse(event.payload));
        for (const decision of this.raw
          .prepare('SELECT context FROM decisions WHERE run_id=? AND hand_id=?')
          .all(run, hand))
          observe(parse(decision.context));
        remove.run(run, hand);
        const last = Number(events.filter((event) => event.type === 'hand_result').at(-1)?.id ?? 0);
        for (const key of keys) insert.run(run, hand, key, last);
      }
      this.db
        .prepare('UPDATE research_locator_cursor SET event_id=?,decision_rowid=? WHERE singleton=1')
        .run(eventMax, decisionMax);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  candidates(key: string): Iterable<{ run_id: string; hand_id: string }> {
    return this.db
      .prepare(
        'SELECT run_id,hand_id FROM research_hand_locators WHERE opponent_key=? ORDER BY event_id DESC,hand_id DESC',
      )
      .iterate(key) as Iterable<{ run_id: string; hand_id: string }>;
  }
  close(): void {
    this.db.close();
  }
}
