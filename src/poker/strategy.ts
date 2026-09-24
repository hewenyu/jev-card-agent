import type { StrategyPackage } from 'duelloop';
import { POKER_INSTRUCTIONS } from '../core/harness.js';
import { BASE_CARDS } from '../knowledge/selector.js';
import { createPokerReplayStrategy } from '../duelloop/strategy.js';
import { POKER_DOMAIN_ID, POKER_FEATURE_CONTRACT, POKER_RULES_VERSION } from './domain.js';

/** Reviewed baseline; all mutable strategic guidance is release content, never hidden facts. */
export function createPokerStrategy(): StrategyPackage {
  const rubric = createPokerReplayStrategy().questions[0]!;
  return {
    schemaVersion: '2.0',
    strategyId: 'openpoker-long-run-chip-quality',
    version: 'baseline-v1',
    scope: {
      domain: POKER_DOMAIN_ID,
      rulesVersion: POKER_RULES_VERSION,
      featureContract: POKER_FEATURE_CONTRACT,
    },
    stateProjection: ['poker', 'facts'],
    questions: [
      {
        ...rubric,
        instructions: [
          'Score candidate {{candidate.id}} relative to all other legal priced candidates using only visible facts. Use the following reviewed poker guidance.',
          ...POKER_INSTRUCTIONS.fundamentals,
          ...BASE_CARDS.map((card) => `${card.street}: ${card.text}`),
          POKER_INSTRUCTIONS.semantics.replace(
            'Select exactly one supplied candidate.',
            'Score each supplied candidate independently; the declared selection rule chooses the action.',
          ),
        ].join('\n'),
        semantics: {
          target: 'holistic ordinal current-action chip quality, not calibrated expected value',
          horizon: 'current hand and repeated-game chip expectation',
          continuation: 'same release with updated visible state and frozen historical facts',
          overlap: 'single holistic dimension; do not double count risk and value',
        },
      },
    ],
    decision: {
      defaultWeights: { chip_quality: 1 },
      branches: [],
      branchPolicy: 'first_match',
      aggregate: 'weighted_sum',
      selection: { mode: 'argmax', tieBreak: 'domain_priority' },
    },
    provenance: {
      researchRunId: 'bootstrap',
      snapshotId: 'bootstrap',
      hypothesis:
        'Human-reviewed baseline from v1.4.3 POKER_INSTRUCTIONS and BASE_CARDS. Choice-to-Score changes selection behavior; no profitability claim.',
    },
  };
}
