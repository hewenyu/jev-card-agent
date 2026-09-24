import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PokerState } from '../core/types.js';
import { serializeEvent, type ServerEvent } from '../openpoker/protocol.js';
import type {
  ActionStatus,
  DecisionRecord,
  RuntimeCheckpoint,
  RuntimePhase,
  RuntimeStore,
  StoredAction,
} from '../runtime/types.js';
import { json, openDatabase } from './database.js';
import { proposalCost } from './cost.js';
import { recentOutcomes } from './history.js';
import { sessionTurns } from './session.js';
import { getOpponentMemory, initializeOpponentMemory } from './opponent-memory.js';
import { STRATEGY_VERSIONS } from '../core/index.js';
import type { FundingEventView } from '../shared/api.js';
import {
  initializeDecisionEvidence,
  knowledgeSourceRevision,
  pinKnowledge,
  refreshKnowledge,
  type AdviceSource,
  type KnowledgeSource,
} from './knowledge.js';
import type { DecisionTiming } from '../runtime/timing.js';
import { KnowledgeIntegrityError } from './knowledge-archive.js';
import type { KnowledgeBinding } from '../knowledge/types.js';
import {
  initializeFunding,
  loadFundingState,
  recentFundingEvents,
  saveFundingEvent,
} from './funding.js';

export class Store implements RuntimeStore {
  readonly db: DatabaseSync;
  readonly owner = randomUUID();
  knowledgeSource?: KnowledgeSource;
  adviceSource?: AdviceSource;
  private handKnowledge: KnowledgeBinding | null = null;
  private archivedKnowledgeKey?: string;
  private archivedSourceRevision?: string;
  constructor(
    readonly filename: string,
    readonly model = 'jev-1.13.0',
  ) {
    this.db = openDatabase(filename);
    initializeFunding(this.db);
    initializeOpponentMemory(this.db);
    initializeDecisionEvidence(this.db);
  }

  beginRun(run: Parameters<RuntimeStore['beginRun']>[0]): void {
    this.db
      .prepare(
        `INSERT INTO runs(id,mode,strategy,model,status,started_at,config)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.kind,
        run.strategy,
        run.strategy === 'baseline' ? 'heuristic-v1' : this.model,
        'running',
        run.startedAt,
        JSON.stringify({
          ...run.config,
          strategyVersions: STRATEGY_VERSIONS,
          codeRevision: process.env.APP_REVISION || 'local-uncommitted',
        }),
      );
    this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('active_run',?)").run(run.id);
  }

  finishRun(id: string, status: RuntimePhase, endedAt: string, error: string | null): void {
    this.db
      .prepare('UPDATE runs SET status=?, ended_at=?, reason=? WHERE id=?')
      .run(status, endedAt, error, id);
  }
  saveDecisionBlock(block: {
    runId: string;
    decisionId: string;
    reason: string;
    createdAt: string;
  }): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('decision_block',?)")
      .run(JSON.stringify(block));
  }
  loadDecisionBlock(): {
    runId: string;
    decisionId: string;
    reason: string;
    createdAt: string;
  } | null {
    return json(
      this.db.prepare("SELECT value FROM meta WHERE key='decision_block'").get()?.value,
      null,
    );
  }
  clearDecisionBlock(): void {
    this.db.prepare("DELETE FROM meta WHERE key='decision_block'").run();
  }
  getOpponentMemory(state: PokerState, asOf: string) {
    return getOpponentMemory(this.db, state, asOf);
  }

  pinKnowledge(state: PokerState, observedAt: string) {
    if (
      this.handKnowledge?.pin.tableId === state.tableId &&
      this.handKnowledge?.pin.handId === state.handId
    )
      return this.handKnowledge;
    try {
      this.handKnowledge = freezeEvidence(
        pinKnowledge(this.db, state, observedAt, this.knowledgeSource, this.adviceSource),
      );
    } catch (error) {
      if (error instanceof KnowledgeIntegrityError) {
        const run = this.db.prepare("SELECT value FROM meta WHERE key='active_run'").get();
        this.saveDecisionBlock({
          runId: String(run?.value ?? 'unavailable'),
          decisionId: randomUUID(),
          reason: error.message,
          createdAt: observedAt,
        });
      }
      throw error;
    }
    return this.handKnowledge;
  }
  refreshKnowledge(at = new Date().toISOString()): void {
    if (this.adviceSource) {
      const revision = knowledgeSourceRevision(this.knowledgeSource, this.adviceSource, at);
      const cacheable = !this.db.isTransaction;
      if (cacheable && revision !== undefined && revision === this.archivedSourceRevision) return;
      const contentKey = refreshKnowledge(
        this.db,
        this.knowledgeSource,
        this.adviceSource,
        at,
        cacheable ? this.archivedKnowledgeKey : undefined,
      );
      if (cacheable) {
        this.archivedKnowledgeKey = contentKey;
        this.archivedSourceRevision = revision;
      }
    }
  }
  saveDecisionTiming(decisionId: string, timing: DecisionTiming): void {
    this.db
      .prepare('INSERT OR REPLACE INTO decision_timings(decision_id,payload) VALUES(?,?)')
      .run(decisionId, JSON.stringify(timing));
  }
  decisionTiming(decisionId: string): DecisionTiming | undefined {
    const row = this.db
      .prepare('SELECT payload FROM decision_timings WHERE decision_id=?')
      .get(decisionId);
    return row ? json<DecisionTiming>(row.payload, {} as DecisionTiming) : undefined;
  }

  recentOutcomes(asOf: string, excludeHandId: string) {
    return recentOutcomes(this, asOf, excludeHandId);
  }

  sessionTurns(tableId: string, handId: string, asOf: string, beforeSeq: number) {
    return sessionTurns(this, tableId, handId, asOf, beforeSeq);
  }

  saveFundingEvent(event: FundingEventView, dedupeKey?: string): void {
    saveFundingEvent(this.db, event, dedupeKey);
  }
  loadFundingState() {
    return loadFundingState(this.db);
  }
  recentFundingEvents(options: { limit?: number; before?: string } = {}): FundingEventView[] {
    return recentFundingEvents(this.db, options);
  }
  appendEvent(runId: string, event: ServerEvent, receivedAt: string): number | void {
    const accountEvent =
      ['rebuy_confirmed', 'auto_rebuy_scheduled'].includes(event.type) ||
      (event.type === 'error' && event.code === 'rebuy_cooldown');
    const sequence =
      !accountEvent && event.type !== 'resync_response' && typeof event.table_seq === 'number'
        ? event.table_seq
        : null;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events(run_id,hand_id,table_id,seq,type,received_at,payload)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        typeof event.hand_id === 'string' ? event.hand_id : null,
        typeof event.table_id === 'string' ? event.table_id : null,
        sequence,
        String(event.type),
        receivedAt,
        serializeEvent(event),
      );
    if (Number(result.changes) > 0) return Number(result.lastInsertRowid);
    const prior = this.db
      .prepare('SELECT id FROM events WHERE run_id=? AND table_id IS ? AND seq IS ?')
      .get(runId, event.table_id ?? null, sequence);
    if (prior) return Number(prior.id);
  }

  saveDecision(decision: DecisionRecord): void {
    const cost = proposalCost(this, decision.proposal);
    const failed = decision.status === 'failed';
    if (failed) this.db.exec('SAVEPOINT failed_decision');
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO decisions
        (id,run_id,hand_id,street,created_at,context,candidates,proposal,source,selected,status,
         latency_ms,cost_usd,fallback_reason,model) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          decision.id,
          decision.runId,
          decision.handId,
          decision.context.street,
          decision.createdAt,
          JSON.stringify(decision.context),
          JSON.stringify(decision.candidates),
          JSON.stringify(decision.proposal),
          decision.proposal.source,
          decision.proposal.candidateId,
          decision.status ?? 'proposed',
          decision.proposal.latencyMs,
          cost,
          decision.fallbackReason,
          decision.proposal.model ?? null,
        );
      if (decision.timing) this.saveDecisionTiming(decision.id, decision.timing);
      if (decision.status === 'failed' || decision.status === 'cancelled')
        this.db
          .prepare(
            "UPDATE decisions SET status=?,fallback_reason=?,proposal=?,source=?,selected=? WHERE id=? AND status='proposed'",
          )
          .run(
            decision.status,
            decision.fallbackReason,
            JSON.stringify(decision.proposal),
            decision.proposal.source,
            decision.proposal.candidateId,
            decision.id,
          );
      if (failed) {
        this.saveDecisionBlock({
          runId: decision.runId,
          decisionId: decision.id,
          reason: decision.fallbackReason ?? 'model_decision_unavailable',
          createdAt: decision.createdAt,
        });
        this.db.exec('RELEASE failed_decision');
      }
    } catch (error) {
      if (failed) this.db.exec('ROLLBACK TO failed_decision; RELEASE failed_decision');
      throw error;
    }
  }

  prepareAction(action: StoredAction): void {
    const previous = this.db.prepare('SELECT payload FROM actions WHERE id=?').get(action.id);
    const payload = JSON.stringify(action.payload);
    if (previous && previous.payload !== payload) throw new Error('Action ID payload conflict');
    this.db.exec('SAVEPOINT prepared_action');
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO actions
        (id,run_id,decision_id,table_id,payload,status,created_at,deadline_at)
        VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          action.id,
          action.runId,
          action.decisionId,
          action.tableId,
          payload,
          action.status,
          action.createdAt,
          action.deadlineAt,
        );
      if (action.stateKey)
        this.db
          .prepare('INSERT OR IGNORE INTO action_authorities(action_id,state_key) VALUES(?,?)')
          .run(action.id, action.stateKey);
      this.db.exec('RELEASE prepared_action');
    } catch (error) {
      this.db.exec('ROLLBACK TO prepared_action; RELEASE prepared_action');
      throw error;
    }
  }

  updateAction(id: string, status: ActionStatus, details?: Record<string, unknown>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          "UPDATE actions SET status=?,details=? WHERE id=? AND status NOT IN ('accepted','rejected')",
        )
        .run(status, JSON.stringify(details ?? {}), id);
      this.db
        .prepare(
          `UPDATE decisions SET status=(SELECT status FROM actions WHERE id=?)
        WHERE id=(SELECT decision_id FROM actions WHERE id=?)`,
        )
        .run(id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pendingActions(): StoredAction[] {
    return this.db
      .prepare(
        `SELECT a.*,d.source AS decision_source,k.state_key FROM actions a LEFT JOIN decisions d
        ON d.id=a.decision_id LEFT JOIN action_authorities k ON k.action_id=a.id
        WHERE a.status IN ('prepared','sent','unresolved')`,
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        runId: String(row.run_id),
        decisionId: String(row.decision_id),
        decisionSource: row.decision_source as StoredAction['decisionSource'],
        tableId: String(row.table_id),
        payload: json<StoredAction['payload']>(row.payload, {} as StoredAction['payload']),
        status: row.status as ActionStatus,
        createdAt: String(row.created_at),
        deadlineAt: Number(row.deadline_at),
        timing: this.decisionTiming(String(row.decision_id)),
        ...(row.state_key ? { stateKey: String(row.state_key) } : {}),
      }));
  }

  saveCheckpoint(checkpoint: RuntimeCheckpoint): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('checkpoint',?)")
      .run(JSON.stringify(checkpoint));
  }
  loadCheckpoint(): RuntimeCheckpoint | null {
    return json<RuntimeCheckpoint | null>(
      this.db.prepare("SELECT value FROM meta WHERE key='checkpoint'").get()?.value,
      null,
    );
  }

  saveHand(runId: string, state: PokerState, event: ServerEvent): void {
    if (!state.handId || !state.tableId) return;
    const existing = this.db.prepare('SELECT * FROM hands WHERE id=?').get(state.handId);
    const start =
      state.heroSeat === null ? null : (state.handStartStacks[String(state.heroSeat)] ?? null);
    const isResult = event.type === 'hand_result';
    const finalStacks =
      event.final_stacks && typeof event.final_stacks === 'object'
        ? (event.final_stacks as Record<string, unknown>)
        : {};
    const finalValue = state.heroSeat === null ? null : finalStacks[String(state.heroSeat)];
    const end =
      typeof finalValue === 'number' && Number.isSafeInteger(finalValue) && finalValue >= 0
        ? finalValue
        : null;
    const initial = typeof existing?.initial_stack === 'number' ? existing.initial_stack : start;
    const complete =
      isResult &&
      initial !== null &&
      end !== null &&
      !state.historyIncomplete &&
      (!existing || existing.run_id === runId);
    const profit = complete ? end - initial : null;
    const now = typeof event.ts === 'string' ? event.ts : new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hands
      (id,run_id,table_id,hand_number,board,hero_cards,profit,big_blind,status,started_at,ended_at,complete,initial_stack,final_stack)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        board=CASE WHEN json_array_length(excluded.board)>=json_array_length(hands.board) THEN excluded.board ELSE hands.board END,
        hero_cards=CASE WHEN json_array_length(excluded.hero_cards)>=json_array_length(hands.hero_cards) THEN excluded.hero_cards ELSE hands.hero_cards END,
        initial_stack=COALESCE(hands.initial_stack,excluded.initial_stack),
        profit=CASE WHEN excluded.complete=1 THEN excluded.profit ELSE hands.profit END,
        final_stack=CASE WHEN excluded.complete=1 OR hands.complete=0 THEN excluded.final_stack ELSE hands.final_stack END,
        ended_at=COALESCE(hands.ended_at,excluded.ended_at),
        status=CASE WHEN hands.status='complete' THEN hands.status ELSE excluded.status END,
        complete=MAX(hands.complete,excluded.complete)`,
      )
      .run(
        state.handId,
        runId,
        state.tableId,
        typeof event.hand_number === 'number'
          ? event.hand_number
          : Number(
              existing?.hand_number ??
                Number(
                  this.db.prepare('SELECT COUNT(*) AS n FROM hands WHERE run_id=?').get(runId)?.n ??
                    0,
                ) + 1,
            ),
        JSON.stringify(state.board),
        JSON.stringify(state.holeCards),
        profit,
        state.bigBlind,
        isResult ? 'complete' : 'playing',
        now,
        isResult ? now : null,
        Number(complete),
        initial,
        isResult ? end : null,
      );
  }

  acquireLease(name = 'runtime', ttlMs = 15_000): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO leases(name,owner,expires_at) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE leases.expires_at < ? OR leases.owner = ?`,
      )
      .run(name, this.owner, now + ttlMs, now, this.owner);
    return Number(result.changes) === 1;
  }
  assertRuntimeLease(): void {
    const lease = this.db.prepare("SELECT owner,expires_at FROM leases WHERE name='runtime'").get();
    if (lease?.owner !== this.owner || Number(lease.expires_at) <= Date.now())
      throw new Error('Runtime database lease is not owned or has expired');
  }
  releaseLease(name = 'runtime'): void {
    this.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name, this.owner);
  }
  close(): void {
    this.releaseLease();
    this.db.close();
  }
}

function freezeEvidence<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}
