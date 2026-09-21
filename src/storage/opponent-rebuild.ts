import { createInitialState, record, reduceMessage } from '../core/state.js';
import { OpponentTracker } from '../core/opponents.js';
import type { PokerState, RawMessage } from '../core/types.js';
import { json } from './database.js';
import type { Store } from './store.js';

export const OPPONENT_REBUILD_VERSION = 'opponents-pre-action-street-v1';
const META_KEY = 'opponent_checkpoint_rebuild';
export interface OpponentRebuildResult {
  version: string;
  eventCount: number;
  opponentCount: number;
  throughEventId: number;
  reused: boolean;
}

/** Explicit offline migration of derived statistics; raw history and frozen inputs stay intact. */
export function rebuildOpponentCheckpoint(store: Store): OpponentRebuildResult {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const lease = db.prepare("SELECT expires_at FROM leases WHERE name='runtime'").get();
    if (lease && Number(lease.expires_at) > Date.now())
      throw new Error('Stop the runtime before rebuilding opponent statistics');
    const checkpoint = store.loadCheckpoint();
    if (!checkpoint) throw new Error('No checkpoint to rebuild');
    if (checkpoint.state.handId && !checkpoint.state.complete)
      throw new Error('Finish the current hand before rebuilding opponent statistics');
    const throughEventId = Number(
      db
        .prepare(
          "SELECT COALESCE(MAX(e.id),0) AS id FROM events e JOIN runs r ON r.id=e.run_id WHERE r.mode='live'",
        )
        .get()?.id ?? 0,
    );
    const previous = json<OpponentRebuildResult | null>(
      db.prepare('SELECT value FROM meta WHERE key=?').get(META_KEY)?.value,
      null,
    );
    if (
      previous?.version === OPPONENT_REBUILD_VERSION &&
      previous.throughEventId === throughEventId
    ) {
      db.exec('COMMIT');
      return { ...previous, reused: true };
    }

    const tracker = new OpponentTracker();
    const tables = new Map<string, PokerState>();
    let activeTableId: string | null = null;
    let eventCount = 0;
    const observe = (state: PokerState, message: RawMessage): PokerState => {
      const next = reduceMessage(state, message);
      tracker.observe(next);
      return next;
    };
    const rows = db
      .prepare(
        "SELECT e.payload FROM events e JOIN runs r ON r.id=e.run_id WHERE r.mode='live' AND e.id<=? ORDER BY e.id",
      )
      .iterate(throughEventId);
    for (const row of rows) {
      eventCount++;
      const message = record(JSON.parse(String(row.payload)));
      const snapshot = record(message.snapshot);
      const tableId: string | null =
        typeof message.table_id === 'string'
          ? message.table_id
          : typeof snapshot.table_id === 'string'
            ? snapshot.table_id
            : activeTableId;
      if (!tableId) continue;
      activeTableId = tableId;
      let state = tables.get(tableId) ?? createInitialState();
      if (message.type === 'resync_response') {
        const watermark = message.to_table_seq ?? message.table_seq;
        // Observe each replayed hand before the final snapshot replaces it. The reducer
        // and tracker independently reject duplicate sequences/actions across reconnects.
        if (typeof watermark !== 'number' || watermark >= state.lastTableSeq) {
          const replay = Array.isArray(message.replayed_events)
            ? message.replayed_events.map(record)
            : [];
          replay.sort((a, b) => Number(a.table_seq ?? 0) - Number(b.table_seq ?? 0));
          for (const event of replay) state = observe(state, event);
        }
      }
      tables.set(tableId, observe(state, message));
    }
    const opponents = tracker.exportState();
    store.saveCheckpoint({ ...checkpoint, opponents });
    const result: OpponentRebuildResult = {
      version: OPPONENT_REBUILD_VERSION,
      eventCount,
      opponentCount: opponents.stats.length,
      throughEventId,
      reused: false,
    };
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(
      META_KEY,
      JSON.stringify(result),
    );
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
