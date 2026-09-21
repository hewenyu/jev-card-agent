import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FundingEventView, FundingView } from '../shared/api.js';
import { record, type ServerEvent } from '../openpoker/protocol.js';

export function fundingIdentity(event: ServerEvent, sourceId: string): string {
  if (typeof event.event_id === 'string') return `ws:event:${event.event_id}`;
  const at = event.rebuy_at ?? record(event.details).rebuy_at;
  if (
    event.type === 'auto_rebuy_scheduled' &&
    typeof at === 'string' &&
    Number.isFinite(Date.parse(at))
  )
    return `ws:scheduled:${new Date(at).toISOString()}`;
  // The protocol does not promise an id for confirmations. A balance is not an identity.
  return `ws:observation:${sourceId}`;
}
export function fundingEventId(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}
export function fundingAvailableAt(event: ServerEvent, observedAt: string): string | null {
  const detail = record(event.details);
  const date = event.rebuy_at ?? detail.rebuy_at;
  const seconds = event.cooldown_seconds ?? detail.cooldown_seconds;
  const timestamp =
    typeof date === 'string' && Number.isFinite(Date.parse(date))
      ? Date.parse(date)
      : typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
        ? Date.parse(observedAt) + seconds * 1000
        : NaN;
  const result = new Date(timestamp);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}
export function initializeFunding(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS funding_events (
    id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES runs(id), created_at TEXT NOT NULL,
    kind TEXT NOT NULL, source TEXT NOT NULL, amount INTEGER,
    available_before INTEGER, available_after INTEGER, chips_at_table INTEGER, rebuy_available_at TEXT
  );
  CREATE INDEX IF NOT EXISTS funding_events_page ON funding_events(created_at DESC,id DESC);`);
  const watermark = Number(
    db.prepare("SELECT value FROM meta WHERE key='funding_history_through_id'").get()?.value ?? 0,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db
      .prepare(
        "SELECT id,run_id,received_at,payload,type FROM events WHERE id>? AND type IN ('rebuy_confirmed','auto_rebuy_scheduled') ORDER BY id",
      )
      .iterate(watermark)) {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(row.payload)) as ServerEvent;
      } catch {
        continue;
      }
      const identity = fundingIdentity(event, String(row.id));
      const at = fundingAvailableAt(event, String(row.received_at));
      saveFundingEvent(
        db,
        {
          id: fundingEventId(identity),
          runId: String(row.run_id),
          createdAt: String(row.received_at),
          kind: row.type === 'rebuy_confirmed' ? 'rebuy_confirmed' : 'rebuy_scheduled',
          source: 'ws',
          amount: row.type === 'rebuy_confirmed' ? 1500 : null,
          availableBefore: null,
          availableAfter: null,
          chipsAtTable: null,
          rebuyAvailableAt: at,
        },
        identity,
      );
    }
    const latest = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get();
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('funding_history_through_id',?)").run(
      String(latest?.id ?? 0),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function saveFundingEvent(
  db: DatabaseSync,
  event: FundingEventView,
  dedupeKey = event.id,
): void {
  db.prepare(
    `INSERT INTO funding_events
    (id,dedupe_key,run_id,created_at,kind,source,amount,available_before,available_after,chips_at_table,rebuy_available_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET
      available_after=COALESCE(funding_events.available_after,excluded.available_after),
      chips_at_table=COALESCE(funding_events.chips_at_table,excluded.chips_at_table)`,
  ).run(
    event.id,
    dedupeKey,
    event.runId,
    event.createdAt,
    event.kind,
    event.source,
    event.amount,
    event.availableBefore,
    event.availableAfter,
    event.chipsAtTable,
    event.rebuyAvailableAt,
  );
}
export function recentFundingEvents(
  db: DatabaseSync,
  options: { limit?: number; before?: string } = {},
): FundingEventView[] {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Funding event limit must be 1–500');
  const cursor = options.before
    ? db.prepare('SELECT created_at,id FROM funding_events WHERE id=?').get(options.before)
    : undefined;
  if (options.before && !cursor) return [];
  const rows = cursor
    ? db
        .prepare(
          'SELECT * FROM funding_events WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?',
        )
        .all(cursor.created_at!, cursor.id!, limit)
    : db
        .prepare('SELECT * FROM funding_events ORDER BY created_at DESC,id DESC LIMIT ?')
        .all(limit);
  return rows.map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    createdAt: String(row.created_at),
    kind: String(row.kind) as FundingEventView['kind'],
    source: String(row.source) as FundingEventView['source'],
    amount: row.amount === null ? null : Number(row.amount),
    availableBefore: row.available_before === null ? null : Number(row.available_before),
    availableAfter: row.available_after === null ? null : Number(row.available_after),
    chipsAtTable: row.chips_at_table === null ? null : Number(row.chips_at_table),
    rebuyAvailableAt: row.rebuy_available_at === null ? null : String(row.rebuy_available_at),
  }));
}

export function loadFundingState(db: DatabaseSync): Partial<FundingView> | undefined {
  const latest = (kind: FundingEventView['kind']) =>
    db
      .prepare(
        `SELECT f.* FROM funding_events f JOIN runs r ON r.id=f.run_id
     WHERE r.mode='live' AND f.kind=? ORDER BY f.created_at DESC,f.id DESC LIMIT 1`,
      )
      .get(kind);
  const balance = latest('balance_sync');
  const confirmed = latest('rebuy_confirmed');
  const scheduled = latest('rebuy_scheduled');
  if (!balance && !confirmed && !scheduled) return undefined;
  const cooldownKnown =
    scheduled && (!confirmed || String(scheduled.created_at) > String(confirmed.created_at));
  return {
    availableChips: balance?.available_after == null ? null : Number(balance.available_after),
    chipsAtTable: balance?.chips_at_table == null ? null : Number(balance.chips_at_table),
    updatedAt: balance ? String(balance.created_at) : null,
    lastRebuyAt: confirmed ? String(confirmed.created_at) : null,
    rebuyAvailableAt:
      cooldownKnown && scheduled.rebuy_available_at != null
        ? String(scheduled.rebuy_available_at)
        : null,
  };
}
