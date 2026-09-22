import { describe, expect, it } from 'vitest';
import { AsyncControlStore, effectiveResearchMode } from '../src/research/control.js';

describe('private research activation', () => {
  it('requires explicit confirmation, preserves audit and never overrides off configuration', () => {
    const store = new AsyncControlStore(':memory:');
    try {
      expect(effectiveResearchMode('live', store.get())).toBe('shadow');
      expect(() => store.setMode('live', { actor: 'owner', note: 'reviewed' })).toThrow(
        'confirmation',
      );
      const confirmed = store.setMode('live', {
        actor: 'owner',
        note: 'reviewed',
        confirmLive: true,
      });
      expect(effectiveResearchMode('live', confirmed)).toBe('live');
      expect(effectiveResearchMode('shadow', confirmed)).toBe('shadow');
      expect(effectiveResearchMode('off', confirmed)).toBe('off');
      store.setMode('off', { actor: 'owner', note: 'withdraw experiment' });
      expect(effectiveResearchMode('live', store.get())).toBe('off');
      store.setMode('shadow', { actor: 'owner', note: 'observe only' });
      expect(effectiveResearchMode('live', store.get())).toBe('shadow');
    } finally {
      store.close();
    }
  });
});
