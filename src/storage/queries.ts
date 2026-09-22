import type { Candidate, DecisionContext, Proposal } from '../core/types.js';
import type {
  DecisionView,
  EvaluationView,
  HandDetail,
  HandSummary,
  RunSummary,
} from '../shared/api.js';
import { json, redact } from './database.js';
import type { Store } from './store.js';

export interface PageOptions {
  limit?: number;
  before?: string;
  completedOnly?: boolean;
}
type Row = Record<string, unknown>;
function pageLimit(limit = 500): number {
  return Math.min(500, Math.max(1, Math.trunc(limit)));
}
const optionalString = (value: unknown): string | null => (value == null ? null : String(value));

export class Queries {
  constructor(readonly store: Store) {}
  runs(options: PageOptions = {}): RunSummary[] {
    const cursor = options.before
      ? this.store.db.prepare('SELECT started_at,id FROM runs WHERE id=?').get(options.before)
      : undefined;
    if (options.before && !cursor) return [];
    return this.store.db
      .prepare(
        `SELECT r.*,
      (SELECT COUNT(*) FROM hands h WHERE h.run_id=r.id AND h.status='complete') AS hands,
      (SELECT COUNT(*) FROM hands h WHERE h.run_id=r.id AND h.complete=1 AND h.profit IS NOT NULL) AS settled_hands,
      (SELECT COUNT(*) FROM hands h WHERE h.run_id=r.id AND h.status='complete' AND h.complete=0) AS excluded_hands,
      (SELECT COUNT(*) FROM decisions d WHERE d.run_id=r.id) AS decisions,
      (SELECT COALESCE(SUM(profit),0) FROM hands h WHERE h.run_id=r.id AND complete=1) AS profit,
      (SELECT 100.0*SUM(profit/big_blind)/COUNT(*) FROM hands h
       WHERE h.run_id=r.id AND complete=1 AND big_blind>0 AND profit IS NOT NULL) AS bb100,
      COALESCE((SELECT SUM(COALESCE(charged_nanos,reserved_nanos))/1e9 FROM usage u WHERE u.run_id=r.id),
        (SELECT COALESCE(SUM(cost_usd),0) FROM decisions d WHERE d.run_id=r.id)) AS cost,
      (SELECT COUNT(*) FROM decisions d WHERE d.run_id=r.id AND source='fallback') AS fallbacks
      FROM runs r ${cursor ? 'WHERE (r.started_at,r.id)<(?,?)' : ''}
      ORDER BY r.started_at DESC,r.id DESC LIMIT ?`,
      )
      .all(
        ...(cursor ? [String(cursor.started_at), String(cursor.id)] : []),
        pageLimit(options.limit),
      )
      .map((row) => ({
        id: String(row.id),
        mode: row.mode as RunSummary['mode'],
        strategy: row.strategy as RunSummary['strategy'],
        model: String(row.model),
        status: String(row.status),
        startedAt: String(row.started_at),
        endedAt: optionalString(row.ended_at),
        hands: Number(row.hands),
        settledHands: Number(row.settled_hands),
        excludedHands: Number(row.excluded_hands),
        decisions: Number(row.decisions),
        netChips: Number(row.profit),
        bb100: row.bb100 === null ? null : Number(row.bb100),
        costUsd: Number(row.cost),
        fallbackCount: Number(row.fallbacks),
        reason: optionalString(row.reason),
      }));
  }
  hands(runId?: string, options: PageOptions = {}): HandSummary[] {
    const cursor = options.before
      ? this.store.db.prepare('SELECT started_at,id FROM hands WHERE id=?').get(options.before)
      : undefined;
    if (options.before && !cursor) return [];
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (runId) {
      filters.push('run_id=?');
      values.push(runId);
    }
    if (options.completedOnly) filters.push("status='complete'");
    if (cursor) {
      filters.push('(started_at,id)<(?,?)');
      values.push(String(cursor.started_at), String(cursor.id));
    }
    const rows = this.store.db
      .prepare(
        `SELECT * FROM hands
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
      ORDER BY started_at DESC,id DESC LIMIT ?`,
      )
      .all(...values, pageLimit(options.limit));
    return rows.map(handView);
  }
  decision(id: string): DecisionView | null {
    const row = this.store.db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
    return row ? this.decisionEvidence(row) : null;
  }
  decisions(runId: string, limit = 100): DecisionView[] {
    return this.store.db
      .prepare('SELECT * FROM decisions WHERE run_id=? ORDER BY created_at LIMIT ?')
      .all(runId, Math.min(500, Math.max(1, limit)))
      .map((row) => this.decisionEvidence(row));
  }
  handDecisions(tableId: string, handId: string): DecisionView[] {
    return this.store.db
      .prepare('SELECT * FROM decisions WHERE hand_id=? ORDER BY created_at,id')
      .all(handId)
      .filter(
        (row) =>
          json<Partial<import('../core/types.js').DecisionContext>>(row.context, {}).tableId ===
          tableId,
      )
      .map((row) => this.decisionEvidence(row));
  }
  hand(id: string): HandDetail | null {
    const row = this.store.db.prepare('SELECT * FROM hands WHERE id=?').get(id);
    if (!row) return null;
    return {
      hand: handView(row),
      decisions: this.store.db
        .prepare('SELECT * FROM decisions WHERE hand_id=? ORDER BY created_at')
        .all(id)
        .map((row) => this.decisionEvidence(row)),
      events: this.store.db
        .prepare('SELECT * FROM events WHERE hand_id=? ORDER BY id')
        .all(id)
        .map((event) => ({
          id: String(event.id),
          type: String(event.type),
          receivedAt: String(event.received_at),
          payload: redact(json(event.payload, {})) as Record<string, unknown>,
        })),
    };
  }
  evaluations(): EvaluationView[] {
    return this.store.db
      .prepare('SELECT result FROM evaluations ORDER BY created_at DESC LIMIT 100')
      .all()
      .map((row) => json<EvaluationView>(row.result, {} as EvaluationView));
  }
  private decisionEvidence(row: Row): DecisionView {
    const view = decisionView(row);
    view.timing = this.store.decisionTiming(view.id);
    const context = json<Partial<DecisionContext>>(row.context, {});
    if (context.knowledge) {
      view.knowledge = redact(context.knowledge) as DecisionView['knowledge'];
      const source = this.store.knowledgeSource;
      const status = source?.status();
      view.audit = source?.getAudit(view.id) ?? {
        decisionId: view.id,
        inputHash: null,
        computedAt: null,
        status: !status?.enabled ? 'disabled' : status.error ? 'failed' : 'pending',
        uniformShowdownReference: null,
        provenance: 'asynchronous_audit_not_model_input',
      };
    }
    return view;
  }
  saveEvaluation(result: EvaluationView): void {
    this.store.db
      .prepare('INSERT INTO evaluations(id,created_at,result) VALUES(?,?,?)')
      .run(result.id, result.createdAt, JSON.stringify(result));
  }
  metrics(mode: 'live' | 'demo') {
    const rows = this.store.db
      .prepare(
        `SELECT d.latency_ms,d.source,d.status,d.cost_usd
      FROM decisions d JOIN runs r ON r.id=d.run_id WHERE r.mode=?`,
      )
      .all(mode);
    const completed = this.store.db
      .prepare(
        `SELECT h.profit,h.big_blind FROM hands h
      JOIN runs r ON r.id=h.run_id WHERE r.mode=? AND h.complete=1 AND h.profit IS NOT NULL`,
      )
      .all(mode);
    const latencies = rows.map((row) => Number(row.latency_ms)).sort((a, b) => a - b);
    const costs = this.store.db
      .prepare(
        `SELECT SUM(COALESCE(u.charged_nanos,u.reserved_nanos))/1e9 AS cost
      FROM usage u JOIN runs r ON r.id=u.run_id WHERE r.mode=?`,
      )
      .get(mode);
    return {
      hands: completed.length,
      decisions: rows.length,
      netChips: completed.reduce((sum, row) => sum + Number(row.profit), 0),
      bb100: completed.length
        ? (completed.reduce((sum, row) => sum + Number(row.profit) / Number(row.big_blind), 0) /
            completed.length) *
          100
        : null,
      costUsd:
        costs?.cost == null
          ? rows.reduce((sum, row) => sum + Number(row.cost_usd), 0)
          : Number(costs.cost),
      fallbackRate: rows.length
        ? rows.filter((row) => row.source === 'fallback').length / rows.length
        : 0,
      p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0,
      unresolved: rows.filter((row) =>
        ['sent', 'unresolved', 'prepared'].includes(String(row.status)),
      ).length,
    };
  }
}

function handView(row: Row): HandSummary {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    tableId: String(row.table_id),
    handNumber: Number(row.hand_number),
    board: json<string[]>(row.board, []),
    heroCards: json<string[]>(row.hero_cards, []),
    profit: row.profit === null ? null : Number(row.profit),
    bigBlind: Number(row.big_blind),
    status: String(row.status),
    startedAt: String(row.started_at),
    endedAt: optionalString(row.ended_at),
    complete: Boolean(row.complete),
  };
}
function decisionView(row: Row): DecisionView {
  const proposal = json<Partial<Proposal>>(row.proposal, {});
  const request = proposal.source === 'jev' && row.source === 'jev' ? proposal.request : undefined;
  const publicObject = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (redact(value) as Record<string, unknown>)
      : undefined;
  const modelInput = publicObject(request?.state);
  const modelQuestions = publicObject(request?.questions);
  return {
    id: String(row.id),
    runId: String(row.run_id),
    handId: String(row.hand_id),
    street: String(row.street),
    createdAt: String(row.created_at),
    context: redact(json(row.context, {})) as Record<string, unknown>,
    ...(modelInput ? { modelInput } : {}),
    ...(modelQuestions ? { modelQuestions } : {}),
    candidates: json<Candidate[]>(row.candidates, []).map((c) => ({
      id: c.id,
      label: c.label,
      action: { kind: c.action, ...(c.amount === undefined ? {} : { raiseToChips: c.amount }) },
    })),
    selectedCandidateId: optionalString(row.selected),
    source: String(row.source),
    probabilities: proposal.probabilities ?? {},
    confidence: proposal.confidence ?? null,
    status: String(row.status),
    latencyMs: Number(row.latency_ms),
    costUsd: Number(row.cost_usd),
    fallbackReason: optionalString(row.fallback_reason),
    model: optionalString(row.model),
    routing: proposal.routing,
    attempts: proposal.attempts,
  };
}
