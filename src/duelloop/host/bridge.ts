import {
  digest,
  type DuelLoop,
  type ExecutionReceipt,
  type FeedbackEvent,
  type SqliteStore,
} from 'duelloop';
import type { PokerState } from '../../core/types.js';
import { decisionStateKey } from '../../runtime/authority.js';
import type { RuntimeStore, StoredAction } from '../../runtime/types.js';
import type { ServerEvent } from '../../openpoker/protocol.js';
import { string } from '../../openpoker/protocol.js';
import type { Store } from '../../storage/store.js';
import type { HandBindings } from '../live/bindings.js';
import { HostJournal } from './journal.js';

/** At-least-once SDK delivery; raw evidence and its outbox entry share a host transaction. */
export class HostBridge {
  readonly store: RuntimeStore;
  constructor(
    readonly raw: Store,
    readonly journal: HostJournal,
    readonly sdk: SqliteStore,
    readonly runtime: DuelLoop,
    readonly bindings: HandBindings,
  ) {
    this.store = new Proxy(raw, {
      get: (target, property) => {
        if (property === 'pinKnowledge') return undefined;
        if (property === 'appendEvent')
          return (runId: string, event: ServerEvent, at: string) => {
            const id = journal.atomic(() => {
              const id = raw.appendEvent(runId, event, at);
              this.recordEvidence(event, at, id);
              return id;
            });
            this.flushReceipts();
            return id;
          };
        if (property === 'prepareAction') return (action: StoredAction) => this.prepare(action);
        if (property === 'saveHand')
          return (runId: string, state: PokerState, event: ServerEvent) => {
            journal.atomic(() => {
              raw.saveHand(runId, state, event);
              if (event.type === 'hand_result') this.recordFeedback(state, event);
            });
          };
        if (property === 'updateAction')
          return (
            id: string,
            status: Parameters<RuntimeStore['updateAction']>[1],
            details?: Record<string, unknown>,
          ) => {
            raw.updateAction(id, status, details);
            if (status === 'unresolved' && sdk.intent(id)) {
              const prior = sdk.intent(id)?.receipt;
              if (!prior || prior.status === 'unknown') {
                const key = `uncertain:${id}:${digest(details ?? {})}`;
                const existing = journal.db
                  .prepare('SELECT 1 FROM framework_outbox WHERE event_key=?')
                  .get(key);
                if (!existing)
                  journal.enqueue(key, {
                    kind: 'receipt',
                    value: {
                      decisionId: id,
                      idempotencyKey: id,
                      eventId: key,
                      status: 'unknown',
                      timestamp: Date.now(),
                      details: { reason: String(details?.reason ?? 'execution_unknown') },
                    },
                  });
                this.flushReceipts();
              }
            }
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private recordEvidence(event: ServerEvent, at: string, sourceId: number | void): void {
    if (!['action_ack', 'action_rejected', 'player_action'].includes(event.type)) return;
    const id = string(event.client_action_id) ?? string(event.action_id);
    if (!id) return;
    const decision = this.journal.getDecision(id);
    if (!decision) return;
    const row = this.journal.db
      .prepare('SELECT payload FROM framework_execution WHERE decision_id=?')
      .get(id);
    if (!row) return;
    const action = JSON.parse(String(row.payload)) as StoredAction;
    if (
      (event.table_id && event.table_id !== action.tableId) ||
      (event.hand_id && event.hand_id !== action.payload.hand_id)
    )
      return;
    if (event.type === 'action_ack' && !['accepted', 'rejected'].includes(String(event.status)))
      return;
    if (
      event.type === 'player_action' &&
      typeof event.action === 'string' &&
      event.action !== action.payload.action
    )
      throw new Error('Execution proof action differs from submitted command');
    if (typeof sourceId !== 'number') throw new Error('Execution proof has no durable raw event');
    const persisted = this.raw.db.prepare('SELECT payload FROM events WHERE id=?').get(sourceId);
    if (!persisted || digest(JSON.parse(String(persisted.payload))) !== digest(event))
      throw new Error('Execution proof conflicts with its durable raw event');
    const status =
      event.type === 'action_rejected' ||
      (event.type === 'action_ack' && event.status === 'rejected')
        ? 'rejected'
        : 'completed';
    // Official V2 contract: a successful applied action emits the cached matching ack;
    // the matching player_action is equivalent execution proof (docs: reconnection/idempotency).
    const key = `arena:${id}:${digest(event)}`;
    if (this.journal.db.prepare('SELECT 1 FROM framework_outbox WHERE event_key=?').get(key))
      return;
    const receipt: ExecutionReceipt = {
      decisionId: id,
      idempotencyKey: id,
      eventId: key,
      status,
      timestamp: Date.parse(at),
      environmentActionId: id,
      details: {
        source: event.type,
        evidenceDigest: digest(event),
        sourceEventId: sourceId ?? null,
      },
    };
    this.journal.enqueue(key, { kind: 'receipt', value: receipt });
  }

  private verifyCommand(action: StoredAction) {
    const intent = this.sdk.intent(action.id);
    const decision = this.journal.getDecision(action.decisionId);
    if (
      !intent ||
      !decision ||
      intent.command.idempotencyKey !== action.payload.client_action_id ||
      action.id !== action.decisionId
    )
      throw new Error('Host action has no matching durable SDK intent');
    const command = intent.command;
    if (
      !decision.action ||
      digest(command.action) !== digest(decision.action) ||
      digest(command.observation) !== digest(decision.observation) ||
      command.expectedStateRevision !== command.observation.revision ||
      command.action.revision !== command.observation.revision
    )
      throw new Error('Host command differs from immutable SDK decision');
    if (
      command.observation.strategyScopeId !== this.bindings.scopeId ||
      command.observation.trajectoryId !==
        JSON.stringify([action.tableId, action.payload.hand_id]) ||
      command.observation.streamId !== JSON.stringify([command.observation.actorId, action.tableId])
    )
      throw new Error('Host command environment identity changed');
    if (
      command.action.kind !== action.payload.action ||
      command.action.parameters.action !== action.payload.action ||
      (action.payload.action === 'raise'
        ? command.action.parameters.raiseToChips !== action.payload.amount
        : action.payload.amount !== undefined)
    )
      throw new Error('Host command action or amount differs from SDK selection');
    if (action.deadlineAt !== command.deadline || !action.stateKey)
      throw new Error('Host command original authority changed');
    return intent;
  }

  prepare(action: StoredAction): void {
    this.verifyCommand(action);
    const hash = digest(action.payload);
    this.journal.atomic(() => {
      const prior = this.journal.db
        .prepare('SELECT payload_hash FROM framework_execution WHERE decision_id=?')
        .get(action.id);
      if (prior && prior.payload_hash !== hash) throw new Error('Host execution payload changed');
      this.raw.prepareAction(action);
      this.journal.db
        .prepare('INSERT OR IGNORE INTO framework_execution VALUES(?,?,?,?,?)')
        .run(action.id, hash, JSON.stringify(action), 'ready_to_send', new Date().toISOString());
    });
  }

  beforeSend(action: StoredAction, state: PokerState): void {
    this.raw.assertRuntimeLease();
    const intent = this.verifyCommand(action);
    const row = this.journal.db
      .prepare('SELECT payload_hash,payload FROM framework_execution WHERE decision_id=?')
      .get(action.id);
    if (!row || row.payload_hash !== digest(action.payload))
      throw new Error('Execution bridge is incomplete');
    const persisted = JSON.parse(String(row.payload)) as StoredAction;
    if (
      persisted.stateKey !== action.stateKey ||
      persisted.deadlineAt !== action.deadlineAt ||
      persisted.tableId !== action.tableId
    )
      throw new Error('Prepared command authority changed');
    const identity = this.bindings.identity(state);
    if (
      identity.streamId !== intent.streamId ||
      identity.actorId !== intent.command.observation.actorId ||
      identity.trajectoryId !== intent.command.observation.trajectoryId ||
      decisionStateKey(state) !== intent.command.expectedStateRevision
    )
      throw new Error('Execution revision or environment identity changed');
    if (intent.receipt && ['completed', 'rejected'].includes(intent.receipt.status))
      throw new Error('Execution already resolved');
    if (Date.now() >= Math.min(action.deadlineAt, intent.command.deadline))
      throw new Error('Execution authority expired');
    if (
      decisionStateKey(state, false) !== action.stateKey ||
      state.turnToken !== action.payload.turn_token
    )
      throw new Error('Execution state changed');
    this.sdk.assertOwner(intent.scopeId, intent.streamId, intent.ownerToken);
    this.journal.db
      .prepare(
        "UPDATE framework_execution SET state='possibly_sent',updated_at=? WHERE decision_id=?",
      )
      .run(new Date().toISOString(), action.id);
  }

  assertNoUnknown(streamId: string): void {
    const pending = this.sdk.unresolvedIntents(this.bindings.scopeId, streamId);
    if (pending.length) throw new Error('Unresolved SDK execution blocks this stream');
    // Legacy unknown commands remain blockers even though they have no SDK artifact.
    const legacy = this.raw
      .pendingActions()
      .filter((action) => !this.journal.getDecision(action.id));
    if (legacy.length)
      throw new Error('Unresolved legacy actions require execution reconciliation before cutover');
  }

  private recordFeedback(state: PokerState, event: ServerEvent): void {
    if (!state.tableId || !state.handId) return;
    const identity = this.bindings.identity(state);
    const pin = this.journal.db
      .prepare(
        'SELECT release FROM framework_hands WHERE scope=? AND stream=? AND actor=? AND trajectory=?',
      )
      .get(identity.scopeId, identity.streamId, identity.actorId, identity.trajectoryId);
    if (!pin?.release) return;
    const hand = this.raw.db
      .prepare('SELECT profit,complete,big_blind,ended_at FROM hands WHERE id=? AND table_id=?')
      .get(state.handId, state.tableId);
    if (!hand?.complete || hand.profit === null || Number(hand.big_blind) <= 0) return;
    const id = `hand:${identity.scopeId}:${identity.trajectoryId}`;
    const metrics = {
      netChips: Number(hand.profit),
      netBb: Number(hand.profit) / Number(hand.big_blind),
    };
    const contentHash = digest({ metrics, settled: true });
    const previous = this.journal.db
      .prepare('SELECT revision,content_hash FROM framework_feedback WHERE feedback_id=?')
      .get(id);
    if (previous?.content_hash === contentHash) return;
    const revision = Number(previous?.revision ?? 0) + 1;
    const eventTime = Date.parse(String(event.ts ?? hand.ended_at));
    const feedback: FeedbackEvent = {
      feedbackId: id,
      revision,
      applicationId: 'jev-card-agent',
      strategyScopeId: identity.scopeId,
      trajectoryId: identity.trajectoryId,
      eventTime: Number.isFinite(eventTime) ? eventTime : Date.now(),
      receivedAt: Date.now(),
      metrics,
      settled: true,
    };
    this.journal.enqueue(`feedback:${id}:${revision}`, { kind: 'feedback', value: feedback });
    this.journal.db
      .prepare(
        'INSERT INTO framework_feedback VALUES(?,?,?) ON CONFLICT(feedback_id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash',
      )
      .run(id, revision, contentHash);
  }

  flushReceipts(): void {
    for (const item of this.journal.pending('receipt')) {
      if (item.payload.kind !== 'receipt') continue;
      try {
        const receipt = item.payload.value;
        const decision = this.journal.getDecision(receipt.decisionId);
        if (!decision) throw new Error('Receipt decision missing');
        const previous = this.sdk.intent(receipt.decisionId)?.receipt;
        if (previous && ['completed', 'rejected'].includes(previous.status)) {
          if (
            ['completed', 'rejected'].includes(receipt.status) &&
            previous.status !== receipt.status
          )
            throw new Error('Conflicting terminal execution proofs');
          // Preserve duplicate/older evidence in raw DB, never regress the SDK state.
        } else if (previous?.status !== 'accepted' || receipt.status !== 'unknown') {
          this.runtime.recordHostReceipt(decision, receipt);
        }
        this.journal.delivered(item.key);
      } catch (error) {
        this.journal.failed(item.key);
        throw error;
      }
    }
  }

  async flush(): Promise<void> {
    this.flushReceipts();
    for (const item of this.journal.pending('feedback')) {
      if (item.payload.kind !== 'feedback') continue;
      try {
        await this.runtime.submitFeedback(item.payload.value);
        this.journal.delivered(item.key);
      } catch (error) {
        this.journal.failed(item.key);
        throw error;
      }
    }
  }
}
