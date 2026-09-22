import type { Candidate, DecisionContext, PokerState, Policy, Proposal } from '../core/types.js';
import type { OpponentCheckpoint } from '../core/opponents.js';
import type { ActionPayload, ServerEvent } from '../openpoker/protocol.js';
import type { HistoricalOutcome } from '../core/index.js';
import type { SessionTurn } from '../core/session.js';
import type { FundingEventView, FundingView, LiveDecisionProgress } from '../shared/api.js';
import type { OpponentMemory } from '../core/opponent-memory.js';

export type RuntimePhase =
  | 'idle'
  | 'connecting'
  | 'recovering'
  | 'queued'
  | 'playing'
  | 'cooldown'
  | 'stopping'
  | 'stopped'
  | 'failed';
export interface RuntimeStatus {
  funding?: FundingView;
  decision?: LiveDecisionProgress | null;
  runId: string | null;
  phase: RuntimePhase;
  connected: boolean;
  hands: number;
  decisions: number;
  reconnects: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
  state: PokerState;
}
export interface StartOptions {
  reasoning?: {
    provider: string;
    protocol: string;
    model: string;
    thinking?: 'enabled' | 'disabled';
    effort?: string;
    timeoutMs: number;
  };
  runId?: string;
  kind?: 'live' | 'demo';
  strategy?: string;
  buyIn?: number;
  autoRebuy?: boolean;
  maxHands?: number;
  maxDurationMs?: number;
  decisionTimeoutMs?: number;
  turnTimeoutMs?: number;
  submissionReserveMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  maxReconnectAttempts?: number;
  gracefulStopTimeoutMs?: number;
}
export interface DecisionRecord {
  status?: 'proposed' | 'cancelled' | 'failed';
  id: string;
  runId: string;
  handId: string;
  createdAt: string;
  context: DecisionContext;
  candidates: Candidate[];
  proposal: Proposal;
  fallbackReason: string | null;
}
export type ActionStatus = 'prepared' | 'sent' | 'accepted' | 'rejected' | 'unresolved';
export interface StoredAction {
  decisionSource?: Proposal['source'];
  id: string;
  runId: string;
  decisionId: string;
  tableId: string;
  payload: ActionPayload;
  status: ActionStatus;
  createdAt: string;
  deadlineAt: number;
}
export interface RuntimeCheckpoint {
  opponents?: OpponentCheckpoint;
  tableId: string | null;
  lastTableSeq: number;
  state: PokerState;
}
/** Synchronous methods are SQLite transactions. Throw on failure: no unrecorded action is sent. */
export interface RuntimeStore {
  getOpponentMemory?(state: PokerState, asOf: string): OpponentMemory[];
  loadFundingState?(): Partial<FundingView> | undefined;
  saveFundingEvent?(event: FundingEventView, dedupeKey?: string): void;
  sessionTurns?(tableId: string, handId: string, asOf: string, beforeSeq: number): SessionTurn[];
  recentOutcomes?(asOf: string, excludeHandId: string): HistoricalOutcome[];
  /** Fence every paid call and submission against lease expiry or ownership transfer. */
  assertRuntimeLease?(): void;
  beginRun(run: {
    id: string;
    kind: 'live' | 'demo';
    strategy: string;
    startedAt: string;
    config: StartOptions;
  }): void;
  finishRun(id: string, status: RuntimePhase, endedAt: string, error: string | null): void;
  appendEvent(runId: string, event: ServerEvent, receivedAt: string): number | void;
  saveDecision(decision: DecisionRecord): void;
  saveDecisionBlock?(block: DecisionBlock): void;
  prepareAction(action: StoredAction): void;
  updateAction(id: string, status: ActionStatus, details?: Record<string, unknown>): void;
  pendingActions(): StoredAction[];
  saveCheckpoint(checkpoint: RuntimeCheckpoint): void;
  loadCheckpoint(): RuntimeCheckpoint | null;
  saveHand(runId: string, state: PokerState, event: ServerEvent): void;
}
export interface DecisionBlock {
  runId: string;
  decisionId: string;
  reason: string;
  createdAt: string;
}
export interface RuntimeDependencies {
  apiKey: string;
  policy: Policy;
  store: RuntimeStore;
  wsUrl?: string;
  restUrl?: string;
}
