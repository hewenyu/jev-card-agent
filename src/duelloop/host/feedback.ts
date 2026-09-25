import { digest, type DuelLoop, type FeedbackEvent } from 'duelloop';
import type { PokerState } from '../../core/types.js';
import type { ServerEvent } from '../../openpoker/protocol.js';
import type { HandBindings, HandFacts } from '../live/bindings.js';
import type { HostJournal } from './journal.js';

type Identity = ReturnType<HandBindings['identity']>;
interface DeferredSettlement {
  identity: Identity;
  feedback: FeedbackEvent;
  event: ServerEvent;
  eventDigest: string;
}

/** Preserve settlements even when async hand pinning has not finished yet. */
export class HostDeferredFeedback {
  constructor(
    private readonly journal: HostJournal,
    private readonly runtime: DuelLoop,
    private readonly bindings: HandBindings,
  ) {
    journal.db.exec(`
      CREATE TABLE IF NOT EXISTS framework_deferred_feedback (
        feedback_id TEXT NOT NULL, revision INTEGER NOT NULL,
        scope TEXT NOT NULL, stream TEXT NOT NULL, actor TEXT NOT NULL, trajectory TEXT NOT NULL,
        payload TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(feedback_id,revision));
      CREATE INDEX IF NOT EXISTS framework_deferred_feedback_binding
        ON framework_deferred_feedback(scope,stream,actor,trajectory);
    `);
  }

  /** Called inside the same host transaction as raw.saveHand. Never reads current strategy. */
  record(runId: string, state: PokerState, event: ServerEvent): void {
    if (!state.tableId || !state.handId) return;
    if (
      (event.table_id && event.table_id !== state.tableId) ||
      (event.hand_id && event.hand_id !== state.handId)
    )
      throw new Error('Settlement event identity differs from hand state');
    const identity = this.bindings.identity(state);
    const hand = this.journal.db
      .prepare(
        'SELECT profit,complete,big_blind,ended_at FROM hands WHERE id=? AND table_id=? AND run_id=?',
      )
      .get(state.handId, state.tableId, runId);
    if (!hand?.complete || hand.profit === null || Number(hand.big_blind) <= 0) return;
    const id = `hand:${identity.scopeId}:${identity.trajectoryId}`;
    const metrics = {
      netChips: Number(hand.profit),
      netBb: Number(hand.profit) / Number(hand.big_blind),
    };
    const contentHash = digest({ metrics, settled: true });
    const previous = this.journal.db
      .prepare('SELECT revision,content_hash FROM framework_feedback WHERE feedback_id=?')
      .get(id);
    if (previous?.content_hash === contentHash) return;
    const revision = Number(previous?.revision ?? 0) + 1;
    const receivedAt = Date.now();
    const eventTime = Date.parse(String(event.ts ?? hand.ended_at));
    const feedback: FeedbackEvent = {
      feedbackId: id,
      revision,
      applicationId: 'jev-card-agent',
      strategyScopeId: identity.scopeId,
      trajectoryId: identity.trajectoryId,
      eventTime: Number.isFinite(eventTime) ? eventTime : receivedAt,
      receivedAt,
      metrics,
      settled: true,
    };
    const payload: DeferredSettlement = { identity, feedback, event, eventDigest: digest(event) };
    this.journal.db
      .prepare('INSERT INTO framework_deferred_feedback VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        revision,
        identity.scopeId,
        identity.streamId,
        identity.actorId,
        identity.trajectoryId,
        JSON.stringify(payload),
        digest(payload),
      );
    this.journal.db
      .prepare(
        `INSERT INTO framework_feedback VALUES(?,?,?)
      ON CONFLICT(feedback_id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash`,
      )
      .run(id, revision, contentHash);
  }

  /** Only consume existing complete bindings; never synthesize strategy/facts for old hands. */
  reconcile(): void {
    const rows = this.journal.db
      .prepare(
        `
      SELECT d.*,h.release,h.expected_release,h.facts,h.facts_digest,h.pinned_at
      FROM framework_deferred_feedback d JOIN framework_hands h
        ON h.scope=d.scope AND h.stream=d.stream AND h.actor=d.actor AND h.trajectory=d.trajectory
      WHERE d.scope=? AND d.actor=? AND h.release IS NOT NULL ORDER BY d.rowid LIMIT 100`,
      )
      .all(this.bindings.scopeId, this.bindings.actorId);
    for (const row of rows) {
      const payload = JSON.parse(String(row.payload)) as DeferredSettlement;
      if (digest(payload) !== row.digest || digest(payload.event) !== payload.eventDigest)
        throw new Error('Deferred settlement evidence digest mismatch');
      const { identity, feedback } = payload;
      if (
        identity.scopeId !== row.scope ||
        identity.streamId !== row.stream ||
        identity.actorId !== row.actor ||
        identity.trajectoryId !== row.trajectory ||
        feedback.feedbackId !== row.feedback_id ||
        feedback.revision !== row.revision ||
        feedback.strategyScopeId !== identity.scopeId ||
        feedback.trajectoryId !== identity.trajectoryId
      )
        throw new Error('Deferred settlement binding identity mismatch');
      const release = this.runtime.lookupTrajectoryRelease({
        ...identity,
        strategyScopeId: identity.scopeId,
      });
      // A host partial write cannot establish which strategy actually owned this hand.
      if (!release) continue;
      if (release !== row.release || (row.expected_release && row.expected_release !== release))
        throw new Error('Deferred settlement strategy binding conflict');
      const facts = JSON.parse(String(row.facts)) as HandFacts;
      const pinnedAt = Date.parse(String(row.pinned_at));
      if (
        digest(facts) !== row.facts_digest ||
        ![pinnedAt, Date.parse(facts.cutoff), Date.parse(facts.availableAt)].every(
          Number.isFinite,
        ) ||
        Date.parse(facts.cutoff) > pinnedAt ||
        Date.parse(facts.availableAt) > pinnedAt
      )
        throw new Error('Deferred settlement original facts binding is invalid');
      this.journal.atomic(() => {
        this.journal.enqueue(`feedback:${feedback.feedbackId}:${feedback.revision}`, {
          kind: 'feedback',
          value: feedback,
        });
        this.journal.db
          .prepare('DELETE FROM framework_deferred_feedback WHERE feedback_id=? AND revision=?')
          .run(feedback.feedbackId, feedback.revision);
      });
    }
  }
}
