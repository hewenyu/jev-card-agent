export type RunMode = 'demo' | 'live' | 'evaluation';
export type StrategyName = 'jev' | 'baseline' | 'jev-reasoning';

export interface RunSummary {
  id: string;
  mode: RunMode;
  strategy: StrategyName;
  model: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  hands: number;
  settledHands: number;
  excludedHands: number;
  decisions: number;
  netChips: number;
  bb100: number | null;
  costUsd: number;
  fallbackCount: number;
  reason: string | null;
}

export interface HandSummary {
  id: string;
  runId: string;
  tableId: string;
  handNumber: number;
  board: string[];
  heroCards: string[];
  profit: number | null;
  bigBlind: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  complete: boolean;
}

export interface CandidateView {
  id: string;
  label: string;
  action: { kind: string; raiseToChips?: number };
}

export interface DecisionView {
  id: string;
  runId: string;
  handId: string;
  street: string;
  createdAt: string;
  context: Record<string, unknown>;
  candidates: CandidateView[];
  selectedCandidateId: string | null;
  source: string;
  probabilities: Record<string, number>;
  confidence: number | null;
  status: string;
  latencyMs: number;
  costUsd: number;
  fallbackReason: string | null;
  model: string | null;
  routing?: Record<string, unknown>;
  attempts?: {
    provider: string;
    requestedModel: string;
    actualModel: string | null;
    status: string;
    latencyMs: number;
  }[];
}

export interface TableView {
  tableId: string | null;
  handId: string | null;
  street: string;
  pot: number;
  board: string[];
  heroCards: string[];
  heroSeat: number | null;
  dealerSeat: number | null;
  actorSeat?: number | null;
  stateSeq?: number;
  complete?: boolean;
  seats: {
    seat: number;
    name: string;
    stack: number;
    bet: number;
    folded: boolean;
    status: string;
  }[];
}

export interface ChipMovement {
  id: string;
  tableId: string;
  handId: string;
  seat: number;
  amount: number;
  direction: 'to-pot' | 'from-pot';
}

export interface SpectatorEvent {
  id: string;
  tableId: string;
  handId: string;
  at: string;
  type: string;
  seat?: number;
  action?: string;
  movements: ChipMovement[];
}

export interface SpectatorSnapshot {
  sequence: number;
  observedAt: string;
  runtime: RuntimeView;
  recentEvents: SpectatorEvent[];
}

export interface RuntimeView {
  running: boolean;
  status: string;
  mode: 'idle' | 'live' | 'demo';
  runId: string | null;
  strategy: StrategyName;
  table: TableView | null;
  error: string | null;
}

export interface Overview {
  runtime: RuntimeView;
  runs: RunSummary[];
  recentHands: HandSummary[];
  metrics: {
    hands: number;
    decisions: number;
    netChips: number;
    bb100: number | null;
    costUsd: number;
    fallbackRate: number;
    p95LatencyMs: number;
    unresolved: number;
  };
  performance: { label: string; netChips: number }[];
  capabilities: {
    canControl: boolean;
    liveConfigured: boolean;
    jevConfigured: boolean;
    reasoningConfigured?: boolean;
  };
}

export interface HandDetail {
  hand: HandSummary;
  decisions: DecisionView[];
  events: { id: string; type: string; receivedAt: string; payload: Record<string, unknown> }[];
}

export interface EvaluationView {
  id: string;
  createdAt: string;
  sourceRunId: string;
  strategy: StrategyName;
  samples: number;
  agreements: number;
  errors: number;
  costUsd: number;
  meanLatencyMs: number;
  rows: {
    decisionId: string;
    original: string | null;
    alternative: string | null;
    status: string;
  }[];
}
