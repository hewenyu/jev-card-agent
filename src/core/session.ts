import { createHash } from 'node:crypto';
import type { Action, DecisionSource, Street } from './types.js';

export interface SessionTurn {
  decisionId: string;
  createdAt: string;
  tableSeq: number;
  street: Street;
  status: string;
  source: DecisionSource | 'unknown';
  fallbackReason: string | null;
  action: { kind: Action; raiseToChips?: number } | null;
  analysis: string | null;
  analysisTruncated: boolean;
}
export interface DecisionSession {
  id: string;
  decisionId: string;
  turn: number;
  previousTurns: SessionTurn[];
  totalPreviousTurns: number;
  truncated: boolean;
}
export const MAX_SESSION_TURNS = 12;
export const MAX_SESSION_ANALYSIS = 4000;
export const MAX_SESSION_ANALYSIS_TOTAL = 12000;

/** Local, reproducible session identity; no provider account or action authority is included. */
export function sessionId(tableId: string, handId: string): string {
  return `hand-${createHash('sha256')
    .update(JSON.stringify([tableId, handId]))
    .digest('hex')
    .slice(0, 24)}`;
}
export function buildSession(
  tableId: string,
  handId: string,
  decisionId: string,
  previous: SessionTurn[],
): DecisionSession {
  let remaining = MAX_SESSION_ANALYSIS_TOTAL;
  const previousTurns = structuredClone(previous.slice(-MAX_SESSION_TURNS));
  for (const turn of [...previousTurns].reverse()) {
    turn.source ??= 'unknown';
    turn.fallbackReason ??= null;
    if (!turn.analysis) continue;
    const retained = turn.analysis.slice(0, Math.min(remaining, MAX_SESSION_ANALYSIS));
    turn.analysisTruncated ||= retained.length < turn.analysis.length;
    turn.analysis = retained;
    remaining -= retained.length;
  }
  return {
    id: sessionId(tableId, handId),
    decisionId,
    turn: previous.length + 1,
    previousTurns,
    totalPreviousTurns: previous.length,
    truncated:
      previous.length > MAX_SESSION_TURNS || previousTurns.some((turn) => turn.analysisTruncated),
  };
}
