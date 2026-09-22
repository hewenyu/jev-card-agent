import type { Action } from './types.js';

export type BettingStreet = 'preflop' | 'flop' | 'turn' | 'river';

export interface MemoryAction {
  seat: number;
  name: string | null;
  street: BettingStreet;
  action: Action;
  /** Raise-to for a raise, otherwise the server's nullable amount. */
  amount: number | null;
  contribution: number | null;
  potBefore: number | null;
  toCallBefore: number | null;
  tableSeq: number | null;
}
export interface MemoryEncounter {
  handId: string;
  tableId: string;
  completedAt: string;
  receivedAt: string;
  tableSeq: number | null;
  resultEventId: number;
  board: string[];
  shownCards: string[] | null;
  heroParticipated: boolean;
  /** Observations, never instructions or policy examples. No private hero cards. */
  line: MemoryAction[];
  /** If present, an overly long example retains its first 8 and last 24 actions. */
  omittedActions?: number;
}
export interface MemoryStreetStats {
  observedActions: number;
  raises: number;
  calls: number;
  checks: number;
  folds: number;
  allIns: number;
  /** Positive explicit to_call_before only; missing values are excluded. */
  facedBetObserved: number;
  foldedToObservedBet: number;
  sizedContributions: number;
  contributionToPotSum: number;
}
export interface OpponentMemory {
  version: 'completed-opponent-encounters-v1';
  name: string;
  asOf: string;
  sampledHands: number;
  sampleLimit: number;
  sampleCapped: boolean;
  firstCompletedAt: string;
  lastCompletedAt: string;
  shownHands: number;
  streets: Record<BettingStreet, MemoryStreetStats>;
  showdowns: MemoryEncounter[];
  recentEncountersWithHero: MemoryEncounter[];
  caveats: string[];
}
