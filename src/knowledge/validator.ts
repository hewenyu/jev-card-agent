import { createHash } from 'node:crypto';
import { BASE_CARDS } from './selector.js';
import type { KnowledgeSnapshot } from './types.js';
export const RULESET_VERSION = 'openpoker-nlhe-v2';
export const KNOWLEDGE_CONTEXT_VERSION = 'visible-context-v7';
export function snapshotHash(snapshot: Omit<KnowledgeSnapshot, 'contentHash'>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
export class KnowledgeValidator {
  validate(snapshot: KnowledgeSnapshot): void {
    const { contentHash, ...content } = snapshot;
    if (
      !['baseline', 'deterministic'].includes(snapshot.source) ||
      JSON.stringify(snapshot.cards) !== JSON.stringify(BASE_CARDS)
    )
      throw new Error('Only reviewed deterministic knowledge is publishable');
    if (contentHash !== snapshotHash(content)) throw new Error('Knowledge content hash mismatch');
    if (
      snapshot.rulesetVersion !== RULESET_VERSION ||
      snapshot.contextSchemaVersion !== KNOWLEDGE_CONTEXT_VERSION
    )
      throw new Error('Incompatible knowledge schema');
    if (
      snapshot.source === 'baseline' &&
      (snapshot.version !== 'poker-knowledge-base-v1' ||
        snapshot.evidenceEventId !== 0 ||
        snapshot.opponents.length !== 0 ||
        snapshot.publishedAt !== '1970-01-01T00:00:00.000Z' ||
        snapshot.evidenceCutoff !== '1970-01-01T00:00:00.000Z' ||
        snapshot.expiresAt !== null)
    )
      throw new Error('Baseline knowledge cannot contain empirical evidence');
    if (snapshot.source === 'deterministic' && snapshot.evidenceEventId <= 0)
      throw new Error('Deterministic knowledge needs an evidence watermark');
    if (
      snapshot.opponents.length > 256 ||
      new Set(snapshot.opponents.map((item) => item.name)).size !== snapshot.opponents.length
    )
      throw new Error('Invalid opponent identity window');
    if (!Number.isSafeInteger(snapshot.evidenceEventId) || snapshot.evidenceEventId < 0)
      throw new Error('Invalid evidence watermark');
    const published = Date.parse(snapshot.publishedAt);
    const cutoff = Date.parse(snapshot.evidenceCutoff);
    if (!Number.isFinite(published) || !Number.isFinite(cutoff) || cutoff > published)
      throw new Error('Invalid knowledge cutoffs');
    if (
      snapshot.expiresAt !== null &&
      (!Number.isFinite(Date.parse(snapshot.expiresAt)) ||
        Date.parse(snapshot.expiresAt) <= published)
    )
      throw new Error('Invalid knowledge expiry');
    for (const opponent of snapshot.opponents) {
      if (
        !opponent.name ||
        !Number.isInteger(opponent.sampledHands) ||
        opponent.sampledHands < 1 ||
        opponent.sampledHands > 200 ||
        opponent.sampleLimit !== 200 ||
        !Number.isInteger(opponent.shownHands) ||
        opponent.shownHands < 0 ||
        opponent.shownHands > opponent.sampledHands
      )
        throw new Error('Invalid opponent sample counts');
      if (
        ![opponent.asOf, opponent.firstCompletedAt, opponent.lastCompletedAt].every((value) =>
          Number.isFinite(Date.parse(value)),
        )
      )
        throw new Error('Invalid opponent timestamp');
      if (
        Date.parse(opponent.asOf) > cutoff ||
        Date.parse(opponent.firstCompletedAt) > Date.parse(opponent.lastCompletedAt) ||
        Date.parse(opponent.lastCompletedAt) >= cutoff ||
        opponent.sampledHands > 200
      )
        throw new Error('Opponent evidence exceeds cutoff or window');
      for (const encounter of [...opponent.showdowns, ...opponent.recentEncountersWithHero]) {
        if (
          ![encounter.completedAt, encounter.receivedAt].every((value) =>
            Number.isFinite(Date.parse(value)),
          )
        )
          throw new Error('Invalid encounter timestamp');
        if (
          !Number.isSafeInteger(encounter.resultEventId) ||
          encounter.resultEventId < 1 ||
          encounter.resultEventId > snapshot.evidenceEventId ||
          Date.parse(encounter.completedAt) >= cutoff ||
          Date.parse(encounter.receivedAt) >= cutoff
        )
          throw new Error('Future opponent evidence');
      }
    }
  }
}
