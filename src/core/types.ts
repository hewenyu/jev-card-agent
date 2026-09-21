import type { RecentOutcome } from './history.js';
import type { StrategyVersions } from './versions.js';
import type { DecisionSession } from './session.js';

export type RawMessage = Record<string, unknown>;
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
  source: 'jev' | 'baseline' | 'fallback';
  explanation: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  request?: RawMessage;
  response?: RawMessage;
  routing?: RawMessage;
  attempts?: ProviderAttempt[];
}
export interface ProviderAttempt {
  retryIndex?: number;
  maxRetries?: number;
  id: string;
  provider: 'jev' | 'responses' | 'messages';
  purpose: 'decision' | 'route_and_decision' | 'analysis' | 'reconsider';
  requestedModel: string;
  actualModel: string | null;
  status: 'succeeded' | 'failed' | 'cancelled' | 'model_mismatch';
  usage: { input_tokens: number; output_tokens: number } | null;
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
