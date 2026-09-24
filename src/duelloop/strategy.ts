import type { StrategyPackage } from 'duelloop';
import {
  POKER_REPLAY_DOMAIN_ID,
  POKER_REPLAY_FEATURE_CONTRACT,
  POKER_REPLAY_RULES_VERSION,
} from './domain.js';

export function createPokerReplayStrategy(): StrategyPackage {
  return {
    schemaVersion: '2.0',
    strategyId: 'openpoker-shadow-chip-quality',
    version: 'v1',
    scope: {
      domain: POKER_REPLAY_DOMAIN_ID,
      rulesVersion: POKER_REPLAY_RULES_VERSION,
      featureContract: POKER_REPLAY_FEATURE_CONTRACT,
    },
    stateProjection: ['poker', 'pokerInstructions'],
    questions: [
      {
        id: 'chip_quality',
        type: 'score',
        forEach: 'candidate',
        normalization: 'divide_by_max_level',
        instructions:
          'Assess candidate {{candidate.id}} against the other legal priced candidates using the archived visible poker facts and guidance. Account jointly for position, current hand strength, relevant opponent evidence, price, new exposure, value and fold equity. Sunk chips alone never justify continuing. Score evidence-supported decision quality for long-run chip expectation; do not invent exact EV, hidden cards, future runouts or a guaranteed result. Do not give a middle score merely because evidence is uncertain.',
        semantics: {
          target: 'holistic ordinal current-action chip quality, not calibrated expected value',
          horizon: 'current hand, with repeated-game expectation as the objective',
          continuation:
            'archived poker guidance for hypothetical later actions; no future observations',
          overlap:
            'single holistic dimension; value and risk are not counted as separate additive scores',
        },
        criteria: [
          'Visible facts strongly contradict this candidate: it is dominated or pays an unjustified price without credible value, draw or bluff support.',
          'Visible facts give weak support: this candidate risks avoidable chips or misses a supported opportunity relative to available alternatives.',
          'Visible facts support a defensible candidate with concrete benefits and drawbacks; neither a clear advantage nor a serious contradiction is established.',
          'Visible facts support a strong candidate: its price, value, controlled exposure or evidence-based fold equity compares favorably with alternatives.',
          'Visible facts strongly favor this candidate over alternatives through clear supported value, a justified continuation, or avoidance of demonstrably unjustified additional exposure.',
        ],
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
        'Human-authored shadow rubric to compare SDK Score decisions with archived Choice decisions. No profitability or independent counterfactual validation claim.',
    },
  };
}
