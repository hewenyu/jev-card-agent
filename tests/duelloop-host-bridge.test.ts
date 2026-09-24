import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest, type FeedbackEvent } from 'duelloop';
import { HostBridge } from '../src/duelloop/host/bridge.js';
import { hostFixture } from './helpers/duelloop-fixture.js';

const fixtures: ReturnType<typeof hostFixture>[] = [];
const fixture = () => {
  const value = hostFixture();
  fixtures.push(value);
  return value;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) await value.close();
});
const ack = (id: string, status = 'accepted') => ({
  type: 'action_ack',
  client_action_id: id,
  status,
  table_id: 'table',
  hand_id: 'hand',
});

describe('DuelLoop host durable execution windows', () => {
  it('recovers the immutable SDK decision projection without another model request', async () => {
    const f = fixture(),
      { record } = await f.decide();
    const calls = f.modelCalls();
    expect(f.journal.getDecision(record.decisionId)).toBeUndefined();
    const event = f.sdk.events({
      scopeId: f.bindings.scopeId,
      types: ['decision'],
      afterId: 0,
      limit: 1,
    })[0]!;
    f.journal.decision(f.sdk.getArtifact(digest(event.data)), 'fixture-run');
    expect(f.journal.getDecision(record.decisionId)).toEqual(record);
    expect(f.modelCalls()).toBe(calls);
    expect(f.sdk.intents()).toHaveLength(0);
  });

  it('a host decision projection before SDK intent is not sendable and resumes the same decision', async () => {
    const f = fixture(),
      { record, action } = await f.decide();
    f.journal.decision(record);
    expect(() => f.bridge.prepare(action)).toThrow('SDK intent');
    expect(() => f.bridge.beforeSend(action, f.state)).toThrow('SDK intent');
    expect(f.raw.pendingActions()).toHaveLength(0);
    const calls = f.modelCalls();
    await f.runtime.prepareHostExecution(record);
    f.bridge.prepare(action);
    expect(() => f.bridge.beforeSend(action, f.state)).not.toThrow();
    expect(f.modelCalls()).toBe(calls);
  });

  it('an SDK intent before host ready blocks other decisions until the original command is re-associated', async () => {
    const f = fixture(),
      { record, action } = await f.decide();
    f.journal.decision(record);
    await f.runtime.prepareHostExecution(record);
    expect(() => f.bridge.beforeSend(action, f.state)).toThrow('incomplete');
    expect(() => f.bridge.assertNoUnknown(record.observation.streamId)).toThrow('Unresolved SDK');
    const calls = f.modelCalls();
    f.bridge.prepare(action);
    f.bridge.beforeSend(action, f.state);
    expect(f.raw.pendingActions()[0]?.id).toBe(record.decisionId);
    expect(f.modelCalls()).toBe(calls);
  });

  it('possibly-sent is durably recorded before any network write or sent status and blocks a new action', async () => {
    const f = fixture(),
      { record, action } = await f.ready();
    f.bridge.beforeSend(action, f.state);
    expect(
      f.journal.db
        .prepare('SELECT state FROM framework_execution WHERE decision_id=?')
        .get(action.id)?.state,
    ).toBe('possibly_sent');
    expect(f.raw.pendingActions()[0]?.status).toBe('prepared');
    const recovered = new HostBridge(f.raw, f.journal, f.sdk, f.runtime, f.bindings);
    expect(() => recovered.assertNoUnknown(record.observation.streamId)).toThrow('Unresolved SDK');
    expect(f.sdk.intent(action.id)?.receipt).toBeNull();
  });

  it('replays ack committed with raw evidence and outbox after delivery failed without sending again', async () => {
    const f = fixture(),
      { action } = await f.ready();
    const failure = vi.spyOn(f.runtime, 'recordHostReceipt').mockImplementationOnce(() => {
      throw new Error('crash before SDK receipt');
    });
    expect(() =>
      f.bridge.store.appendEvent('fixture-run', ack(action.id), new Date().toISOString()),
    ).toThrow('crash before SDK');
    expect(f.raw.db.prepare("SELECT COUNT(*) n FROM events WHERE type='action_ack'").get()?.n).toBe(
      1,
    );
    expect(f.journal.pending('receipt')).toHaveLength(1);
    expect(f.sdk.intent(action.id)?.receipt).toBeNull();
    failure.mockRestore();
    f.bridge.flushReceipts();
    expect(f.sdk.intent(action.id)?.receipt?.status).toBe('completed');
    expect(f.journal.pending()).toHaveLength(0);
    expect(() => f.bridge.beforeSend(action, f.state)).toThrow('resolved');
  });

  it('SDK receipt committed before outbox confirmation is consumed once on retry', async () => {
    const f = fixture(),
      { action } = await f.ready();
    const failure = vi.spyOn(f.journal, 'delivered').mockImplementationOnce(() => {
      throw new Error('crash before outbox marker');
    });
    expect(() =>
      f.bridge.store.appendEvent('fixture-run', ack(action.id), new Date().toISOString()),
    ).toThrow('outbox marker');
    expect(f.sdk.intent(action.id)?.receipt?.status).toBe('completed');
    expect(f.journal.pending('receipt')).toHaveLength(1);
    failure.mockRestore();
    f.bridge.flushReceipts();
    expect(f.sdk.events({ types: ['execution.receipt'] })).toHaveLength(1);
    expect(f.sdk.events({ types: ['host.execution.receipt'] })).toHaveLength(1);
    expect(f.journal.pending()).toHaveLength(0);
  });
});

describe('host action authority and evidence identity', () => {
  it('does not let unknown legacy actions disappear during framework cutover', () => {
    const f = fixture();
    f.raw.prepareAction({
      id: 'legacy',
      decisionId: 'old-decision',
      runId: 'fixture-run',
      tableId: 'old-table',
      status: 'unresolved',
      createdAt: new Date().toISOString(),
      deadlineAt: Date.now() - 1,
      payload: {
        type: 'action',
        action: 'fold',
        hand_id: 'old-hand',
        turn_token: 'old-token',
        client_action_id: 'legacy',
      },
    });
    expect(() => f.bridge.assertNoUnknown('a-new-table')).toThrow('legacy');
    f.raw.updateAction('legacy', 'accepted');
    expect(() => f.bridge.assertNoUnknown('a-new-table')).not.toThrow();
  });

  it('checks immutable action, amount, table, deadline, lease and live revision before sending', async () => {
    const f = fixture(),
      { action } = await f.ready();
    for (const change of [
      { ...action, payload: { ...action.payload, amount: 10 } },
      { ...action, payload: { ...action.payload, action: 'fold' } },
      { ...action, tableId: 'another-table' },
      { ...action, deadlineAt: action.deadlineAt + 1000 },
    ])
      expect(() => f.bridge.beforeSend(change, f.state)).toThrow();
    expect(() => f.bridge.beforeSend(action, { ...f.state, pot: f.state.pot + 1 })).toThrow(
      'revision',
    );
    expect(() => f.bridge.beforeSend(action, { ...f.state, turnToken: 'new-turn' })).toThrow();
    f.raw.db.prepare("UPDATE leases SET expires_at=0 WHERE name='runtime'").run();
    expect(() => f.bridge.beforeSend(action, f.state)).toThrow('lease');
  });

  it('expired original authority remains expired even if a reconnect supplies more time', async () => {
    const f = fixture(),
      { action } = await f.ready();
    const time = vi.spyOn(Date, 'now').mockReturnValue(action.deadlineAt + 1);
    f.raw.db
      .prepare("UPDATE leases SET expires_at=? WHERE name='runtime'")
      .run(action.deadlineAt + 30_000);
    expect(() => f.bridge.beforeSend(action, f.state)).toThrow('expired');
    time.mockRestore();
    expect(() =>
      f.bridge.beforeSend({ ...action, deadlineAt: action.deadlineAt + 60_000 }, f.state),
    ).toThrow('authority');
  });

  it('deduplicates identical acks and ignores old unknown evidence after terminal completion', async () => {
    const f = fixture(),
      { action } = await f.ready();
    const at = new Date().toISOString();
    f.bridge.store.updateAction(action.id, 'unresolved', { reason: 'connection_lost' });
    expect(f.sdk.intent(action.id)?.receipt?.status).toBe('unknown');
    f.bridge.store.appendEvent('fixture-run', ack(action.id), at);
    f.bridge.store.appendEvent(
      'fixture-run',
      ack(action.id),
      new Date(Date.parse(at) + 1000).toISOString(),
    );
    f.journal.enqueue('late-unknown', {
      kind: 'receipt',
      value: {
        decisionId: action.id,
        idempotencyKey: action.id,
        eventId: 'late-unknown',
        status: 'unknown',
        timestamp: Date.now(),
      },
    });
    f.bridge.flushReceipts();
    expect(f.sdk.intent(action.id)?.receipt?.status).toBe('completed');
    expect(f.sdk.events({ types: ['execution.receipt'] })).toHaveLength(2);
    expect(f.journal.pending()).toHaveLength(0);
    expect(() => f.bridge.store.appendEvent('fixture-run', ack(action.id, 'rejected'), at)).toThrow(
      'Conflicting terminal',
    );
    expect(f.sdk.intent(action.id)?.receipt?.status).toBe('completed');
  });

  it('requires matching table, hand, known ack status and actually durable event payload', async () => {
    const f = fixture(),
      { action } = await f.ready();
    const at = new Date().toISOString();
    f.bridge.store.appendEvent('fixture-run', { ...ack(action.id), table_id: 'other' }, at);
    f.bridge.store.appendEvent('fixture-run', { ...ack(action.id), hand_id: 'other' }, at);
    f.bridge.store.appendEvent('fixture-run', ack(action.id, 'pending'), at);
    expect(f.sdk.intent(action.id)?.receipt).toBeNull();
    f.raw.appendEvent('fixture-run', { type: 'heartbeat', table_id: 'table', table_seq: 99 }, at);
    expect(() =>
      f.bridge.store.appendEvent('fixture-run', { ...ack(action.id), table_seq: 99 }, at),
    ).toThrow('durable raw event');
    expect(f.sdk.intent(action.id)?.receipt).toBeNull();
    expect(f.journal.pending()).toHaveLength(0);
  });

  it('rolls raw evidence back if its outbox cannot be committed', async () => {
    const f = fixture(),
      { action } = await f.ready();
    vi.spyOn(f.journal, 'enqueue').mockImplementationOnce(() => {
      throw new Error('outbox disk failure');
    });
    expect(() =>
      f.bridge.store.appendEvent('fixture-run', ack(action.id), new Date().toISOString()),
    ).toThrow('outbox disk');
    expect(f.raw.db.prepare('SELECT COUNT(*) n FROM events').get()?.n).toBe(0);
    expect(f.sdk.intent(action.id)?.receipt).toBeNull();
  });

  it('receipt delivery is not hidden behind the first hundred pending feedback messages', async () => {
    const f = fixture(),
      { action } = await f.ready();
    for (let index = 0; index < 120; index++) {
      const feedback: FeedbackEvent = {
        feedbackId: `pending-${index}`,
        revision: 1,
        applicationId: 'jev-card-agent',
        strategyScopeId: f.bindings.scopeId,
        trajectoryId: `hand-${index}`,
        settled: true,
        metrics: { netChips: index },
        eventTime: 1,
        receivedAt: 1,
      };
      f.journal.enqueue(`feedback-${index}`, { kind: 'feedback', value: feedback });
    }
    f.bridge.store.appendEvent('fixture-run', ack(action.id), new Date().toISOString());
    expect(f.sdk.intent(action.id)?.receipt?.status).toBe('completed');
    expect(f.journal.pending('feedback')).toHaveLength(100);
    expect(f.journal.pending('receipt')).toHaveLength(0);
    const plan = f.raw.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT event_key,payload FROM framework_outbox WHERE delivered=0 AND kind=? ORDER BY rowid LIMIT 100',
      )
      .all('receipt');
    expect(plan.some((row) => String(row.detail).includes('framework_outbox_pending_kind'))).toBe(
      true,
    );
    expect(plan.some((row) => String(row.detail).includes('TEMP B-TREE'))).toBe(false);
  });
});
