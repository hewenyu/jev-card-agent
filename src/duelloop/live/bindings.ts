import { digest, type DuelLoop } from 'duelloop';
import type { PokerState } from '../../core/types.js';
import type { OpponentMemory } from '../../core/opponent-memory.js';
import type { KnowledgeSnapshot } from '../../knowledge/types.js';
import type { HostJournal } from '../host/journal.js';

export interface HandFacts {
  schema: 'poker-facts-v1';
  source: string;
  cutoff: string;
  evidenceEventId: number;
  availableAt: string;
  opponents: OpponentMemory[];
}
export interface HandBinding {
  scopeId: string;
  streamId: string;
  actorId: string;
  trajectoryId: string;
  factsSnapshotDigest: string;
  facts: HandFacts;
  releaseDigest: string;
  pinnedAt: string;
}

export class HandBindings {
  private cached?: HandBinding;
  constructor(
    private readonly journal: HostJournal,
    private readonly runtime: DuelLoop,
    readonly scopeId: string,
    readonly actorId: string,
    private readonly latest: (asOf: string) => KnowledgeSnapshot,
  ) {}

  identity(state: PokerState) {
    if (!state.tableId || !state.handId) throw new Error('Hand identity unavailable');
    return {
      scopeId: this.scopeId,
      streamId: JSON.stringify([this.actorId, state.tableId]),
      actorId: this.actorId,
      trajectoryId: JSON.stringify([state.tableId, state.handId]),
    };
  }

  /** Partial host writes and SDK-only pins are recovery evidence, never a new-hand boundary. */
  hasDurableBinding(state: PokerState): boolean {
    const id = this.identity(state);
    return (
      !!this.journal.db
        .prepare(
          'SELECT 1 FROM framework_hands WHERE scope=? AND stream=? AND actor=? AND trajectory=?',
        )
        .get(id.scopeId, id.streamId, id.actorId, id.trajectoryId) ||
      !!this.runtime.lookupTrajectoryRelease({ ...id, strategyScopeId: id.scopeId })
    );
  }

  pin(state: PokerState, at: string): HandBinding {
    if (!Number.isFinite(Date.parse(at))) throw new Error('Hand binding time is invalid');
    const id = this.identity(state);
    if (this.cached?.trajectoryId === id.trajectoryId && this.cached.streamId === id.streamId)
      return structuredClone(this.cached);
    const key = [id.scopeId, id.streamId, id.actorId, id.trajectoryId];
    const identity = { ...id, strategyScopeId: id.scopeId };
    let row = this.journal.db
      .prepare(
        'SELECT * FROM framework_hands WHERE scope=? AND stream=? AND actor=? AND trajectory=?',
      )
      .get(...key);
    const existingRelease = this.runtime.lookupTrajectoryRelease(identity);
    if (!row) {
      if (existingRelease)
        throw new Error('Pinned release has no recoverable original facts snapshot');
      const latest = this.latest(at);
      if (
        ![latest.publishedAt, latest.evidenceCutoff].every((value) =>
          Number.isFinite(Date.parse(value)),
        )
      )
        throw new Error('Facts timestamp is invalid');
      if (
        Date.parse(latest.publishedAt) > Date.parse(at) ||
        Date.parse(latest.evidenceCutoff) > Date.parse(at)
      )
        throw new Error('Facts are newer than the hand binding');
      const expectedRelease = this.runtime.store.activeRelease(this.scopeId);
      if (!expectedRelease) throw new Error('Hand binding has no active strategy release');
      const facts: HandFacts = {
        schema: 'poker-facts-v1',
        source: latest.version,
        cutoff: latest.evidenceCutoff,
        evidenceEventId: latest.evidenceEventId,
        availableAt: latest.publishedAt,
        // A hand needs only opponents who can participate in it. Retain the full source
        // watermark/cutoff but avoid copying every historical opponent into each hand.
        opponents: structuredClone(
          latest.opponents.filter((opponent) =>
            state.seats.some(
              (seat) =>
                seat.name === opponent.name &&
                seat.seat !== state.heroSeat &&
                seat.inHand !== false &&
                !seat.folded,
            ),
          ),
        ),
      };
      this.journal.db
        .prepare(
          'INSERT INTO framework_hands(scope,stream,actor,trajectory,facts_digest,facts,pinned_at,expected_release) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(...key, digest(facts), JSON.stringify(facts), at, expectedRelease);
      row = this.journal.db
        .prepare(
          'SELECT * FROM framework_hands WHERE scope=? AND stream=? AND actor=? AND trajectory=?',
        )
        .get(...key)!;
    }
    const facts = JSON.parse(String(row.facts)) as HandFacts;
    if (digest(facts) !== row.facts_digest) throw new Error('Pinned facts digest mismatch');
    const pinnedAt = Date.parse(String(row.pinned_at));
    if (
      ![pinnedAt, Date.parse(facts.cutoff), Date.parse(facts.availableAt)].every(Number.isFinite) ||
      Date.parse(facts.cutoff) > pinnedAt ||
      Date.parse(facts.availableAt) > pinnedAt
    )
      throw new Error('Pinned facts time boundary is invalid');
    if (row.release && !existingRelease)
      throw new Error('Pinned facts lost their SDK release binding');
    const expectedRelease = row.expected_release ?? row.release;
    if (!expectedRelease)
      throw new Error('Incomplete hand binding has no original release evidence');
    if (
      existingRelease
        ? existingRelease !== expectedRelease
        : this.runtime.store.activeRelease(this.scopeId) !== expectedRelease
    )
      throw new Error('Original hand strategy release is no longer available for pinning');
    const release = this.runtime.pinTrajectory(identity);
    if (row.release && row.release !== release) throw new Error('Pinned release conflict');
    this.journal.db
      .prepare(
        'UPDATE framework_hands SET release=? WHERE scope=? AND stream=? AND actor=? AND trajectory=? AND release IS NULL',
      )
      .run(release, ...key);
    this.cached = {
      ...id,
      factsSnapshotDigest: String(row.facts_digest),
      facts,
      releaseDigest: release,
      pinnedAt: String(row.pinned_at),
    };
    return structuredClone(this.cached);
  }
}
