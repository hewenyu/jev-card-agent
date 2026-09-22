import type { DecisionAdvice } from './advice.js';
import type { RecentOutcome } from './history.js';
import type { StrategyVersions } from './versions.js';
import type { DecisionSession } from './session.js';
import type { PokerFacts } from './harness.js';
import type { OpponentMemory } from './opponent-memory.js';
import type { DecisionKnowledge } from '../knowledge/types.js';

export type RawMessage = Record<string, unknown>;
export type DecisionSource = 'jev' | 'baseline' | 'fallback' | 'unavailable';
export type Action = 'fold' | 'check' | 'call' | 'raise' | 'all_in';
export type Street = 'idle' | 'preflop' | 'flop' | 'turn' | 'river';
export interface ValidAction {
  action: Action;
  amount?: number;
  min?: number;
  max?: number;
}
export interface Seat {
  seat: number;
  name: string | null;
  stack: number;
  bet: number;
  status: string;
  inHand?: boolean;
  folded?: boolean;
}
export interface HistoryEntry {
  handId: string | null;
  tableSeq: number | null;
  seat: number;
  name: string | null;
  action: Action;
  street: Street;
  amount: number | null;
  toCallBefore: number | null;
  reportedStreet?: string | null;
  streetSource?: 'pre_action_state' | 'event';
  actionId: string | null;
  timestamp: string | null;
}
export interface PokerState {
  tableId: string | null;
  handId: string | null;
  heroSeat: number | null;
  dealerSeat: number | null;
  actorSeat: number | null;
  street: Street;
  pot: number;
  board: string[];
  holeCards: string[];
  seats: Seat[];
  smallBlind: number;
  bigBlind: number;
  validActions: ValidAction[];
  turnToken: string | null;
  lastTableSeq: number;
  history: HistoryEntry[];
  handStartStacks: Record<string, number>;
  complete: boolean;
  historyIncomplete: boolean;
  waitingReason: string | null;
}
export interface Candidate {
  id: string;
  action: Action;
  amount?: number;
  label: string;
}
export interface OpponentStats {
  name: string;
  hands: number;
  vpip: number;
  pfr: number;
  facedBet: number;
  foldedToBet: number;
  lastTableSeq: number;
}
export interface DecisionContext {
  knowledge?: DecisionKnowledge;
  advice?: DecisionAdvice;
  harness?: PokerFacts;
  opponentMemory?: OpponentMemory[];
  session?: DecisionSession;
  version: string;
  strategyVersions: StrategyVersions;
  lastTableSeq: number;
  asOf: string | null;
  recentOutcomes: RecentOutcome[];
  tableId: string | null;
  handId: string | null;
  street: Street;
  heroSeat: number | null;
  dealerSeat: number | null;
  pot: number;
  board: string[];
  holeCards: string[];
  seats: Seat[];
  smallBlind: number;
  bigBlind: number;
  toCall: number;
  potOdds: number | null;
  effectiveStack: number | null;
  history: HistoryEntry[];
  opponents: OpponentStats[];
  historyIncomplete: boolean;
}
export interface Proposal {
  candidateId: string;
  selected: string;
  source: DecisionSource;
  explanation: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  request?: RawMessage;
  requestHash?: string;
  response?: RawMessage;
  routing?: RawMessage;
  attempts?: ProviderAttempt[];
}
export interface ProviderAttempt {
  configuration?: { thinking: 'enabled' | 'disabled'; effort?: string };
  retryIndex?: number;
  maxRetries?: number;
  id: string;
  provider: 'jev' | 'responses' | 'messages' | 'deepseek';
  purpose: 'decision' | 'route_and_decision' | 'analysis' | 'reconsider';
  requestedModel: string;
  actualModel: string | null;
  status: 'succeeded' | 'failed' | 'cancelled' | 'model_mismatch';
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  latencyMs: number;
  errorCode?: string;
  diagnostics?: RawMessage;
}
export interface ProviderCall {
  provider: ProviderAttempt['provider'];
  purpose: ProviderAttempt['purpose'];
  requestedModel: string;
  inputCharacters: number;
  maxOutputTokens: number;
  /** Opt-in private transport archive; never includes HTTP authentication headers. */
  request?: { body: string; sha256: string; inputSha256: string };
}
export interface ProviderMeter {
  before(call: ProviderCall): string | null;
  after(attempt: ProviderAttempt, reservationId: string): void;
}
export interface DecisionProgress {
  attempts?: ProviderAttempt[];
  phase: 'reasoning' | 'jev' | 'completed';
  analysis?: string;
  thinking?: string | null;
  thinkingSource?: 'summary' | 'thinking' | 'not_provided';
  outcome?: string;
}
export interface DecisionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DecisionProgress) => void;
}
export interface Policy {
  decide(
    context: DecisionContext,
    candidates: Candidate[],
    options?: DecisionOptions,
  ): Promise<Proposal>;
}
