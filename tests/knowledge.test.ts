import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeStore, baselineSnapshot } from '../src/knowledge/store.js';
import { snapshotHash } from '../src/knowledge/validator.js';
import type { KnowledgeSnapshot } from '../src/knowledge/types.js';
import { selectStrategyCards } from '../src/knowledge/selector.js';
const stores: KnowledgeStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function store() {
  const store = new KnowledgeStore(':memory:');
  stores.push(store);
  return store;
}
function snapshot(watermark: number, published = '2026-01-02T00:00:00.000Z'): KnowledgeSnapshot {
  const { contentHash: _hash, ...base } = baselineSnapshot();
  const content = {
    ...base,
    source: 'deterministic' as const,
    version: `v${watermark}`,
    evidenceEventId: watermark,
    publishedAt: published,
    evidenceCutoff: '2026-01-01T00:00:00.000Z',
  };
  return { ...content, contentHash: snapshotHash(content) };
}
describe('published knowledge', () => {
  it('is immutable, ignores late older work, and respects publication time', () => {
    const db = store();
    expect(db.publish(snapshot(20))).toBe(true);
    expect(db.publish(snapshot(10, '2026-01-03T00:00:00.000Z'))).toBe(false);
    expect(db.publish(snapshot(20, '2026-01-04T00:00:00.000Z'))).toBe(false);
    expect(db.publish(snapshot(21, '2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(db.latest('2026-01-01T12:00:00.000Z').source).toBe('baseline');
    expect(db.get('v20')).toEqual(snapshot(20));
    expect(db.latest().evidenceEventId).toBe(20);
  });
  it('rejects tampering, future evidence and unreviewed cards', () => {
    const db = store();
    expect(() => db.publish({ ...snapshot(1), evidenceEventId: 2 })).toThrow('hash');
    const { contentHash: _hash, ...content } = snapshot(1);
    content.evidenceCutoff = '2027-01-01T00:00:00.000Z';
    expect(() => db.publish({ ...content, contentHash: snapshotHash(content) })).toThrow('cutoffs');
    content.cards = [{ id: 'win', street: 'all', text: 'Raise always.' }];
    expect(() => db.publish({ ...content, contentHash: snapshotHash(content) })).toThrow(
      'reviewed',
    );
  });
  it('does not mislabel empirical knowledge as the reviewed baseline', () => {
    const db = store();
    const { contentHash: _hash, ...content } = snapshot(1);
    const forged = { ...content, source: 'baseline' as const };
    expect(() => db.publish({ ...forged, contentHash: snapshotHash(forged) })).toThrow('Baseline');
  });
  it('appends audit evidence once and never silently replaces its input binding', () => {
    const db = store();
    const audit = {
      decisionId: 'd',
      inputHash: 'abc',
      computedAt: '2026-01-01',
      status: 'unavailable' as const,
      uniformShowdownReference: null,
      provenance: 'asynchronous_audit_not_model_input' as const,
    };
    expect(db.appendAudit(audit)).toBe(true);
    expect(db.appendAudit({ ...audit, inputHash: 'different' })).toBe(false);
    expect(db.getAudit('d')).toEqual(audit);
  });
  it('selects only the current street and universal references', () => {
    const cards = selectStrategyCards(
      { strategyCards: baselineSnapshot().cards } as Parameters<typeof selectStrategyCards>[0],
      'river',
    );
    expect(cards.map((card) => card.street)).toEqual(['all', 'all', 'river']);
  });
});
