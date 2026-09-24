import type { OpponentStats, PokerState } from '../core/types.js';
import type { DecisionRecord, StoredAction } from './types.js';
import type { LiveDecisionProgress } from '../shared/api.js';

export interface DecisionTask {
  key: string;
  stateKey?: string;
  receivedAt?: number;
  decisionDeadlineAt?: number;
  controller: AbortController;
  deadlineAt: number;
  state: PokerState;
  recovered: boolean;
  recoveryDeadlineKnown?: boolean;
  requireJev?: boolean;
  opponents: OpponentStats[];
}
export interface RuntimeDecisionEngine {
  pin(state: PokerState, at: string): void;
  decide(
    task: DecisionTask,
    runId: string,
    budgetMs: number,
    onProgress?: (progress: LiveDecisionProgress) => void,
  ): Promise<{ decision: DecisionRecord; action: StoredAction | null } | null>;
  beforeSend(action: StoredAction, state: PokerState): void;
  resume(action: StoredAction, state: PokerState): Promise<void>;
  rememberTurn(
    key: string,
    tableId: string,
    receivedAt: number,
    deadlineAt: number,
    decisionDeadlineAt: number,
  ): void;
  loadTurn(
    key: string,
  ):
    | { tableId: string; receivedAt: number; deadlineAt: number; decisionDeadlineAt: number }
    | undefined;
}
