import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { OpponentMemory } from '../core/opponent-memory.js';
import type { DecisionContext, PokerState } from '../core/types.js';
import { estimateUniformEquity } from '../core/poker-cards.js';
import { createInitialState } from '../core/state.js';
import {
  getOpponentMemory,
  initializeOpponentMemory,
  syncOpponentMemory,
} from '../storage/opponent-memory.js';
import { KnowledgeStore, baselineSnapshot } from '../knowledge/store.js';
import { snapshotHash } from '../knowledge/validator.js';
import type { KnowledgeSnapshot, SlowLoopStatus } from '../knowledge/types.js';

export const EVENT_CURSOR = 'completed-opponent-encounters-v1';
export const AUDIT_CURSOR = 'uniform-audit-row-v1';
export const SUMMARY_CURSOR = 'opponent-summary-event-v1';
const AUDIT_ELIGIBLE =
  "json_type(CASE WHEN json_valid(context) THEN context ELSE '{}' END,'$.knowledge')='object'";
/** Runs only in the isolated worker (exported for deterministic integration tests). */
export class StatsWorker {
  private raw: DatabaseSync;
  readonly knowledge: KnowledgeStore;
  constructor(
    rawPath: string,
    derivedPath: string,
    readonly batchSize = 16,
  ) {
    if (
      resolve(rawPath) === resolve(derivedPath) ||
      (existsSync(derivedPath) && realpathSync(rawPath) === realpathSync(derivedPath))
    )
      throw new Error('Knowledge database must be separate from raw history');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw new Error('Batch size must be 1..100');
    this.raw = new DatabaseSync(rawPath, { readOnly: true });
    this.raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
    this.knowledge = new KnowledgeStore(derivedPath);
    initializeOpponentMemory(this.knowledge.db, false);
    this.knowledge.db.exec(`CREATE TABLE IF NOT EXISTS opponent_summaries (
      name TEXT PRIMARY KEY, last_event_id INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opponent_summaries_recent ON opponent_summaries(last_event_id DESC);
      CREATE INDEX IF NOT EXISTS opponent_encounters_watermark ON opponent_encounters(result_event_id,name);`);
  }
  tick(now = new Date().toISOString()): SlowLoopStatus {
    // Finish an interrupted summary batch before materializing any more hands.
    const previous = this.knowledge.cursor(EVENT_CURSOR);
    const summarized = this.knowledge.cursor(SUMMARY_CURSOR);
    const watermark =
      summarized < previous
        ? previous
        : syncOpponentMemory(this.raw, this.knowledge.db, this.batchSize, now);
    if (watermark > summarized) this.summarize(summarized, watermark, now);
    if (watermark > this.knowledge.latest().evidenceEventId) {
      const opponents = this.knowledge.db
        .prepare(
          'SELECT payload FROM opponent_summaries ORDER BY last_event_id DESC,name LIMIT 256',
        )
        .all()
        .map((row) => JSON.parse(String(row.payload)) as OpponentMemory);
      const { contentHash: _hash, ...base } = baselineSnapshot();
      const content: Omit<KnowledgeSnapshot, 'contentHash'> = {
        ...base,
        source: 'deterministic',
        version: `poker-knowledge-v1-e${watermark}`,
        evidenceEventId: watermark,
        evidenceCutoff: now,
        // Logical publication time is sampled after materialization/aggregation, not at
        // the evidence cutoff. Millisecond precision; actual hand adoption is persisted by its pin.
        publishedAt: new Date(Math.max(Date.now(), Date.parse(now))).toISOString(),
        opponents,
        validation: [
          'Completed and received before cutoff; original event watermark; maximum 200 hands per public opponent name.',
          'Snapshot includes at most 256 recently observed opponent identities; older raw evidence and summaries remain stored.',
          'Only fixed reviewed strategy cards; no automatic strategy modification.',
        ],
      };
      this.knowledge.publish({ ...content, contentHash: snapshotHash(content) });
    }
    const upper = Number(
      this.raw.prepare('SELECT MAX(rowid) AS cursor FROM decisions').get()?.cursor ?? 0,
    );
    const rows = this.raw
      .prepare(
        `SELECT rowid AS cursor,id,context FROM decisions WHERE rowid>? AND rowid<=? AND ${AUDIT_ELIGIBLE} ORDER BY rowid LIMIT ?`,
      )
      .all(this.knowledge.cursor(AUDIT_CURSOR), upper, this.batchSize);
    for (const row of rows) {
      const contextText = String(row.context);
      let uniformShowdownReference = null;
      try {
        const context = JSON.parse(contextText) as DecisionContext;
        const opponents = context.seats.filter(
          (seat) =>
            seat.seat !== context.heroSeat &&
            seat.name &&
            seat.inHand !== false &&
            !seat.folded &&
            seat.status !== 'empty' &&
            seat.status !== 'sitting_out',
        ).length;
        uniformShowdownReference = estimateUniformEquity(
          context.holeCards,
          context.board,
          opponents,
        );
      } catch {
        /* Corrupt historical inputs remain visible as unavailable audit rows. */
      }
      this.knowledge.appendAudit({
        decisionId: String(row.id),
        inputHash: createHash('sha256').update(contextText).digest('hex'),
        computedAt: new Date().toISOString(),
        status: uniformShowdownReference ? 'complete' : 'unavailable',
        uniformShowdownReference,
        provenance: 'asynchronous_audit_not_model_input',
      });
      this.knowledge.advance(AUDIT_CURSOR, Number(row.cursor));
    }
    if (rows.length < this.batchSize) this.knowledge.advance(AUDIT_CURSOR, upper);
    return this.status(new Date().toISOString());
  }
  private summarize(after: number, through: number, asOf: string): void {
    const names = this.knowledge.db
      .prepare(
        'SELECT DISTINCT name FROM opponent_encounters WHERE result_event_id>? AND result_event_id<=? ORDER BY name',
      )
      .all(after, through)
      .map((row) => String(row.name));
    const state: PokerState = {
      ...createInitialState(),
      heroSeat: -1,
      seats: names.map((name, seat) => ({ seat, name, stack: 0, bet: 0, status: 'active' })),
    };
    const opponents = getOpponentMemory(this.knowledge.db, state, asOf, false);
    this.knowledge.db.exec('SAVEPOINT summary_batch');
    try {
      const insert = this.knowledge.db
        .prepare(`INSERT INTO opponent_summaries(name,last_event_id,payload)
        VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET last_event_id=excluded.last_event_id,payload=excluded.payload WHERE opponent_summaries.last_event_id<=excluded.last_event_id`);
      for (const opponent of opponents)
        insert.run(opponent.name, through, JSON.stringify(opponent));
      this.knowledge.advance(SUMMARY_CURSOR, through);
      this.knowledge.db.exec('RELEASE summary_batch');
    } catch (error) {
      this.knowledge.db.exec('ROLLBACK TO summary_batch; RELEASE summary_batch');
      throw error;
    }
  }
  status(lastCompletedAt: string | null = null): SlowLoopStatus {
    const eventCursor = this.knowledge.cursor(EVENT_CURSOR);
    const decisionCursor = this.knowledge.cursor(AUDIT_CURSOR);
    return {
      enabled: true,
      running: true,
      lastCompletedAt,
      eventCursor,
      decisionCursor,
      pendingHands: Number(
        this.raw
          .prepare("SELECT COUNT(*) AS count FROM events WHERE type='hand_result' AND id>?")
          .get(eventCursor)?.count ?? 0,
      ),
      pendingAudits: Number(
        this.raw
          .prepare(`SELECT COUNT(*) AS count FROM decisions WHERE rowid>? AND ${AUDIT_ELIGIBLE}`)
          .get(decisionCursor)?.count ?? 0,
      ),
      latestVersion: this.knowledge.latest().version,
      error: null,
    };
  }
  close(): void {
    this.raw.close();
    this.knowledge.close();
  }
}
