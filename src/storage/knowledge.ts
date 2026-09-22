import type { DatabaseSync } from 'node:sqlite';
import type { PokerState } from '../core/types.js';
import { baselineSnapshot } from '../knowledge/store.js';
import { KnowledgeValidator } from '../knowledge/validator.js';
import type {
  AuditView,
  KnowledgeBinding,
  KnowledgeSnapshot,
  SlowLoopStatus,
} from '../knowledge/types.js';

export interface KnowledgeSource {
  latest(asOf?: string): KnowledgeSnapshot;
  status(): SlowLoopStatus;
  getAudit(decisionId: string): AuditView | null;
}

export function initializeDecisionEvidence(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hand_knowledge (
      table_id TEXT NOT NULL, hand_id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(table_id,hand_id)
    );
    CREATE TABLE IF NOT EXISTS decision_timings (
      decision_id TEXT PRIMARY KEY, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS action_authorities (
      action_id TEXT PRIMARY KEY, state_key TEXT NOT NULL
    );
  `);
}

/** Persist a complete immutable binding in the authoritative database, not the worker's DB. */
export function pinKnowledge(
  db: DatabaseSync,
  state: PokerState,
  observedAt: string,
  source?: KnowledgeSource,
): KnowledgeBinding {
  if (!state.tableId || !state.handId) throw new Error('Knowledge requires table and hand');
  const existing = db
    .prepare('SELECT payload FROM hand_knowledge WHERE table_id=? AND hand_id=?')
    .get(state.tableId, state.handId);
  if (existing) return JSON.parse(String(existing.payload)) as KnowledgeBinding;

  // An old hand first seen through resync may already have history. New knowledge is inadmissible.
  const handStart = db
    .prepare(
      "SELECT payload,received_at FROM events WHERE table_id=? AND hand_id=? AND type='hand_start' ORDER BY id LIMIT 1",
    )
    .get(state.tableId, state.handId);
  const event = handStart ? (JSON.parse(String(handStart.payload)) as { ts?: string }) : null;
  const start = event?.ts
    ? Date.parse(event.ts)
    : handStart
      ? Date.parse(String(handStart.received_at))
      : NaN;
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) throw new Error('Invalid knowledge pin time');
  const admissibleAt = new Date(
    Number.isFinite(start) ? Math.min(start, observed) : observed,
  ).toISOString();
  let snapshot = baselineSnapshot();
  try {
    if (handStart) snapshot = source?.latest(admissibleAt) ?? baselineSnapshot();
    new KnowledgeValidator().validate(snapshot);
    if (
      Date.parse(snapshot.publishedAt) > Date.parse(admissibleAt) ||
      Date.parse(snapshot.evidenceCutoff) > Date.parse(admissibleAt) ||
      (snapshot.expiresAt !== null && Date.parse(snapshot.expiresAt) <= observed) ||
      !handStart
    )
      snapshot = baselineSnapshot();
  } catch {
    snapshot = baselineSnapshot();
  }
  const names = new Set(
    state.seats.filter((seat) => seat.seat !== state.heroSeat).map((seat) => seat.name),
  );
  const opponentMemory = snapshot.opponents.filter((memory) => names.has(memory.name));
  const binding: KnowledgeBinding = {
    pin: {
      tableId: state.tableId,
      handId: state.handId,
      knowledgeVersion: snapshot.version,
      snapshotHash: snapshot.contentHash,
      evidenceEventId: snapshot.evidenceEventId,
      pinnedAt: observedAt,
      admissibleAt,
      reason: snapshot.source === 'baseline' ? 'baseline' : 'published',
      opponentMemory,
      strategyCards: snapshot.cards,
    },
    snapshot,
  };
  db.prepare('INSERT OR IGNORE INTO hand_knowledge(table_id,hand_id,payload) VALUES(?,?,?)').run(
    state.tableId,
    state.handId,
    JSON.stringify(binding),
  );
  return JSON.parse(
    String(
      db
        .prepare('SELECT payload FROM hand_knowledge WHERE table_id=? AND hand_id=?')
        .get(state.tableId, state.handId)!.payload,
    ),
  ) as KnowledgeBinding;
}
