import type { DatabaseSync } from 'node:sqlite';
import type { AdviceBundle, AsyncLlmMode } from '../knowledge/advice-types.js';
import { hashAdviceBundle } from '../knowledge/advice-validator.js';
import {
  archiveKnowledge,
  combinedHash,
  eligibleArchive,
  initializeKnowledgeArchives,
  KnowledgeIntegrityError,
  readArchive,
  verifyPublication,
} from './knowledge-archive.js';
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
  revision?(asOf: string): string;
  latest(asOf?: string): KnowledgeSnapshot;
  status(): SlowLoopStatus;
  getAudit(decisionId: string): AuditView | null;
}

export interface AdviceSource {
  mode(): AsyncLlmMode;
  bundleRevision?(options: {
    mode: AsyncLlmMode;
    basePolicyVersion: string;
    admissibleAt: string;
  }): string;
  bundle(options: {
    mode: AsyncLlmMode;
    basePolicyVersion: string;
    admissibleAt: string;
  }): AdviceBundle;
}
/** Cheap source tokens let idle heartbeats avoid copying and validating entire snapshots. */
export function knowledgeSourceRevision(
  source: KnowledgeSource | undefined,
  advice: AdviceSource,
  now: string,
): string | undefined {
  if (!advice.bundleRevision || (source && !source.revision)) return undefined;
  const base = baselineSnapshot();
  return JSON.stringify([
    source?.revision?.(now) ?? base.contentHash,
    advice.bundleRevision({
      mode: advice.mode(),
      basePolicyVersion: base.version,
      admissibleAt: now,
    }),
  ]);
}
function emptyAdvice(mode: AsyncLlmMode): AdviceBundle {
  const content = {
    schemaVersion: 'advice-bundle-v1' as const,
    mode,
    basePolicyVersion: baselineSnapshot().version,
    selectorVersion: 'scope-selector-v1' as const,
    availableAt: '1970-01-01T00:00:00.000Z',
    publications: [],
  };
  return { ...content, bundleHash: hashAdviceBundle(content) };
}
/** Called by the supervisor on publication updates, independently of the action path. */
export function refreshKnowledge(
  db: DatabaseSync,
  source: KnowledgeSource | undefined,
  advice: AdviceSource,
  now: string,
  previousContentKey?: string,
): string {
  const snapshot = source?.latest(now) ?? baselineSnapshot();
  const bundle = advice.bundle({
    mode: advice.mode(),
    basePolicyVersion: baselineSnapshot().version,
    admissibleAt: now,
  });
  const contentKey = `${snapshot.contentHash}:${bundle.bundleHash}`;
  if (contentKey === previousContentKey) return contentKey;
  archiveKnowledge(db, snapshot, bundle, now);
  return contentKey;
}

export function initializeDecisionEvidence(db: DatabaseSync): void {
  initializeKnowledgeArchives(db);
  // These reviewed empty bundles contain no observations and are timeless. Seed before
  // a supervisor can publish the same content at its current wall-clock timestamp.
  for (const mode of ['off', 'shadow', 'live'] as const) {
    const snapshot = baselineSnapshot();
    const advice = emptyAdvice(mode);
    const hash = combinedHash({ schemaVersion: 'combined-knowledge-v2', snapshot, advice });
    if (!db.prepare('SELECT bundle_hash FROM knowledge_archives WHERE bundle_hash=?').get(hash))
      archiveKnowledge(db, snapshot, advice, advice.availableAt);
  }
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
  adviceSource?: AdviceSource,
): KnowledgeBinding {
  if (!state.tableId || !state.handId) throw new Error('Knowledge requires table and hand');
  const existing = db
    .prepare('SELECT payload FROM hand_knowledge WHERE table_id=? AND hand_id=?')
    .get(state.tableId, state.handId);
  if (existing) return restoreBinding(db, String(existing.payload), state.tableId, state.handId);

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
  let archived: ReturnType<typeof eligibleArchive> = null;
  let advice: AdviceBundle | undefined;
  if (adviceSource) {
    const mode = adviceSource.mode();
    archived = handStart ? eligibleArchive(db, mode, admissibleAt) : null;
    if (
      archived &&
      (Date.parse(archived.archive.snapshot.evidenceCutoff) > Date.parse(admissibleAt) ||
        (archived.archive.snapshot.expiresAt !== null &&
          Date.parse(archived.archive.snapshot.expiresAt) <= observed))
    )
      archived = null;
    if (archived) {
      snapshot = archived.archive.snapshot;
      advice = archived.archive.advice;
    } else {
      // Timeless reviewed baseline is admissible even before a first publication is archived.
      advice = emptyAdvice(mode);
      archived = eligibleArchive(db, mode, advice.availableAt);
      if (
        !archived ||
        archived.archive.snapshot.contentHash !== snapshot.contentHash ||
        archived.archive.advice.bundleHash !== advice.bundleHash
      )
        throw new KnowledgeIntegrityError('Reviewed baseline archive is missing or changed');
    }
  }
  if (!adviceSource)
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
      ...(archived
        ? {
            bindingSchema: 'hand-knowledge-v2' as const,
            bundleHash: archived.archive.bundleHash,
            bundleAvailableAt: archived.availableAt,
            bundlePublicationSeq: archived.publicationSeq,
            asyncLlmMode: archived.archive.advice.mode,
          }
        : {}),
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
    ...(advice ? { advice } : {}),
  };
  db.prepare('INSERT OR IGNORE INTO hand_knowledge(table_id,hand_id,payload) VALUES(?,?,?)').run(
    state.tableId,
    state.handId,
    JSON.stringify(
      archived
        ? {
            schemaVersion: 'hand-knowledge-v2',
            pin: {
              ...binding.pin,
              opponentMemory: undefined,
              strategyCards: undefined,
              opponentNames: binding.pin.opponentMemory.map((item) => item.name),
            },
            bundleHash: archived.archive.bundleHash,
          }
        : binding,
    ),
  );
  return restoreBinding(
    db,
    String(
      db
        .prepare('SELECT payload FROM hand_knowledge WHERE table_id=? AND hand_id=?')
        .get(state.tableId, state.handId)!.payload,
    ),
    state.tableId,
    state.handId,
  );
}

/** Legacy full bindings retain their bytes and hashes. New references recover from raw history. */
function restoreBinding(
  db: DatabaseSync,
  payload: string,
  tableId: string,
  handId: string,
): KnowledgeBinding {
  try {
    const stored = JSON.parse(payload) as KnowledgeBinding & {
      schemaVersion?: string;
      bundleHash?: string;
    };
    if (
      ![stored.pin.pinnedAt, stored.pin.admissibleAt].every((value) =>
        Number.isFinite(Date.parse(value)),
      ) ||
      Date.parse(stored.pin.admissibleAt) > Date.parse(stored.pin.pinnedAt)
    )
      throw new Error('Invalid hand admission time');
    if (stored.pin.tableId !== tableId || stored.pin.handId !== handId)
      throw new Error('Hand pin identity mismatch');
    let binding: KnowledgeBinding = stored;
    if (stored.schemaVersion === 'hand-knowledge-v2') {
      if (!stored.bundleHash || stored.pin.bundleHash !== stored.bundleHash)
        throw new Error('Hand archive reference mismatch');
      if (
        !stored.pin.bundleAvailableAt ||
        !Number.isFinite(Date.parse(stored.pin.bundleAvailableAt))
      )
        throw new Error('Invalid archive admission time');
      const found = readArchive(db, stored.bundleHash);
      verifyPublication(
        db,
        stored.bundleHash,
        stored.pin.bundlePublicationSeq,
        stored.pin.bundleAvailableAt,
      );
      if (
        Date.parse(found.availableAt) > Date.parse(stored.pin.bundleAvailableAt!) ||
        found.archive.advice.mode !== stored.pin.asyncLlmMode ||
        Date.parse(stored.pin.bundleAvailableAt!) > Date.parse(stored.pin.admissibleAt)
      )
        throw new Error('Pinned archive availability mismatch');
      const names = (stored.pin as typeof stored.pin & { opponentNames?: string[] }).opponentNames;
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
        throw new Error('Invalid pinned opponent identities');
      const { opponentNames: _names, ...pin } = stored.pin as typeof stored.pin & {
        opponentNames: string[];
      };
      binding = {
        pin: {
          ...pin,
          strategyCards: found.archive.snapshot.cards,
          opponentMemory: found.archive.snapshot.opponents.filter((item) =>
            names.includes(item.name),
          ),
        },
        snapshot: found.archive.snapshot,
        advice: found.archive.advice,
      };
    } else if (stored.schemaVersion !== undefined) throw new Error('Unknown hand binding schema');
    new KnowledgeValidator().validate(binding.snapshot);
    if (
      Date.parse(binding.snapshot.publishedAt) > Date.parse(binding.pin.admissibleAt) ||
      Date.parse(binding.snapshot.evidenceCutoff) > Date.parse(binding.pin.admissibleAt)
    )
      throw new Error('Pinned facts exceed admission boundary');
    if (
      binding.pin.snapshotHash !== binding.snapshot.contentHash ||
      binding.pin.knowledgeVersion !== binding.snapshot.version ||
      binding.pin.evidenceEventId !== binding.snapshot.evidenceEventId ||
      JSON.stringify(binding.pin.strategyCards) !== JSON.stringify(binding.snapshot.cards)
    )
      throw new Error('Pinned snapshot integrity mismatch');
    return binding;
  } catch (error) {
    throw error instanceof KnowledgeIntegrityError
      ? error
      : new KnowledgeIntegrityError(error instanceof Error ? error.message : 'Unreadable hand pin');
  }
}
