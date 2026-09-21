import { CANDIDATE_VERSION } from './candidates.js';

/** Persist with each run and decision; change the relevant version when its behavior changes. */
export const STRATEGY_VERSIONS = Object.freeze({
  context: 'visible-context-v5',
  candidates: CANDIDATE_VERSION,
  historySummary: 'verified-outcomes-v2',
  heuristic: 'heuristic-v1',
  prompt: 'poker-choice-v4',
});

export type StrategyVersions = { [K in keyof typeof STRATEGY_VERSIONS]: string };
