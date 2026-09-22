import { useEffect, useMemo, useRef, useState } from 'react';
import type { HandAudits, HandDetail, HandSummary, RunSummary } from '../../../src/shared/api';
import { api, message, signed, time } from '../api';
import { Decision } from '../components/Decision';
import { PokerTable } from '../components/PokerTable';
import { Cards, Empty, ErrorNotice, Panel, SourceBadge } from '../components/UI';
import { replayTable } from '../replay';

export function Replay({
  run,
  hands,
  selectedHand,
  selectedDecision,
  selectHand,
  historyLoading,
  historyError,
  hasMoreHands,
  loadOlderHands,
}: {
  run: RunSummary | undefined;
  hands: HandSummary[];
  selectedHand: string | null;
  selectedDecision: string | null;
  selectHand: (id: string) => void;
  historyLoading: boolean;
  historyError: string | null;
  hasMoreHands: boolean;
  loadOlderHands: () => void;
}) {
  const [record, setRecord] = useState<HandDetail | null>(null);
  const [cursor, setCursor] = useState(0);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setFilter('all');
  }, [run?.id]);
  // Pin the initial choice in parent state so new completed hands do not move the replay.
  useEffect(() => {
    if (!selectedHand && hands[0]) selectHand(hands[0].id);
  }, [hands, selectedHand, selectHand]);
  const handId = selectedHand ?? hands[0]?.id;
  const summary = hands.find((hand) => hand.id === handId);
  // Hand rows can be completed by late results/resync. New list objects alone are not changes.
  const summarySignature = summary
    ? JSON.stringify([
        summary.tableId,
        summary.handNumber,
        summary.board,
        summary.heroCards,
        summary.profit,
        summary.bigBlind,
        summary.status,
        summary.startedAt,
        summary.endedAt,
        summary.complete,
      ])
    : null;
  const loadedScope = useRef('');
  const runId = run?.id;
  const detail = record && record.hand.id === handId && record.hand.runId === runId ? record : null;
  useEffect(() => {
    let active = true;
    let pending = false;
    let stable: HandDetail | null = null;
    let auditPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scope = JSON.stringify([runId, handId]);
    const changedHand = loadedScope.current !== scope;
    loadedScope.current = scope;
    const controller = new AbortController();
    if (changedHand) {
      setRecord(null);
      setCursor(0);
    }
    setError(null);
    if (!handId) {
      setLoading(false);
      return;
    }
    setLoading(changedHand);
    async function refresh() {
      if (pending || !active) return;
      pending = true;
      clearTimeout(timer);
      try {
        if (stable) {
          if (!auditPending) return;
          const audits = await api<HandAudits>(
            `/hands/${encodeURIComponent(handId!)}/audits`,
            controller.signal,
          );
          if (!active) return;
          const byId = new Map(audits.map((item) => [item.decisionId, item.audit]));
          stable = {
            ...stable,
            decisions: stable.decisions.map((item) => ({
              ...item,
              audit: byId.get(item.id) ?? item.audit,
            })),
          };
          auditPending = stable.decisions.some(
            (item) => item.audit?.status === 'pending' || item.audit?.status === 'failed',
          );
          setRecord(stable);
          setError(null);
          return;
        }
        const value = await api<HandDetail>(
          `/hands/${encodeURIComponent(handId!)}`,
          controller.signal,
        );
        if (!active) return;
        if (value.hand.id !== handId || value.hand.runId !== runId)
          throw new Error('The returned hand does not match the selected run.');
        if (
          value.hand.status === 'complete' &&
          value.hand.complete &&
          value.decisions.every((item) => ['accepted', 'cancelled', 'failed'].includes(item.status))
        ) {
          stable = value;
          auditPending = value.decisions.some(
            (item) => item.audit?.status === 'pending' || item.audit?.status === 'failed',
          );
        }
        setRecord(value);
        setCursor((current) => Math.min(current, Math.max(0, value.events.length - 1)));
        setDecisionId((current) =>
          value.decisions.some((item) => item.id === current)
            ? current
            : (value.decisions[0]?.id ?? null),
        );
        setError(null);
      } catch (reason: unknown) {
        if (active) setError(message(reason));
      } finally {
        pending = false;
        if (active) {
          setLoading(false);
          // Schedule after completion: a slow response cannot overlap a newer request.
          if (!stable || auditPending) timer = setTimeout(() => void refresh(), 3000);
        }
      }
    }
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [handId, runId, summarySignature]);
  useEffect(() => {
    setDecisionId(selectedDecision);
  }, [handId, selectedDecision]);
  const table = useMemo(() => (detail ? replayTable(detail, cursor) : null), [detail, cursor]);
  const decision = detail?.decisions.find((item) => item.id === decisionId) ?? detail?.decisions[0];
  const filteredHands = hands.filter(
    (hand) =>
      filter === 'all' || (filter === 'won' ? (hand.profit ?? 0) > 0 : (hand.profit ?? 0) < 0),
  );
  const event = detail?.events[cursor];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">A DECISION HAS A HISTORY</p>
          <h1>Replay the evidence.</h1>
          <p className="subtle">Explore what the agent knew, chose, and actually executed.</p>
        </div>
        {run && <SourceBadge mode={run.mode} />}
      </div>
      <ErrorNotice error={error} />
      <div className="replay-layout">
        <aside className="panel hand-browser">
          <div className="panel-header">
            <h2>Hand history</h2>
            <span className="count">{hands.length} loaded</span>
          </div>
          <label className="field hand-filter">
            Result filter
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All results</option>
              <option value="won">Winning hands</option>
              <option value="lost">Losing hands</option>
            </select>
          </label>
          <div className="hand-list">
            {filteredHands.map((hand) => (
              <button
                className={`hand-item ${hand.id === handId ? 'selected' : ''}`}
                key={hand.id}
                onClick={() => selectHand(hand.id)}
                aria-pressed={hand.id === handId}
              >
                <div>
                  <strong>Hand #{String(hand.handNumber).padStart(3, '0')}</strong>
                  <span
                    className={
                      hand.profit === null ? undefined : hand.profit >= 0 ? 'positive' : 'negative'
                    }
                  >
                    {hand.profit === null
                      ? hand.status === 'complete'
                        ? 'Unverified'
                        : 'Open'
                      : signed(hand.profit)}
                  </span>
                </div>
                <Cards cards={hand.heroCards} size="small" />
                <small>{time(hand.startedAt)}</small>
              </button>
            ))}
            {!filteredHands.length && !historyLoading && <Empty title="No matching hands" />}
          </div>
          <div className="history-pagination">
            <ErrorNotice error={historyError} />
            {historyLoading && <p role="status">Loading hand history…</p>}
            {(hasMoreHands || historyError) && (
              <button
                className="button compact secondary full-width"
                onClick={loadOlderHands}
                disabled={historyLoading}
              >
                {historyError ? 'Retry hand history' : 'Load older hands'}
              </button>
            )}
            {!hasMoreHands && !historyLoading && !historyError && hands.length > 0 && (
              <p className="annotation">All recorded hands loaded.</p>
            )}
            {hasMoreHands && <p className="annotation">Result filter applies to loaded hands.</p>}
          </div>
        </aside>
        <div className="replay-main">
          {loading ? (
            <div className="loading-state" role="status">
              Loading hand record…
            </div>
          ) : !detail ? (
            <Panel>
              <Empty title="Choose a hand to replay">
                Recorded hands will appear here after a run.
              </Empty>
            </Panel>
          ) : (
            <>
              <Panel
                className="table-panel"
                title={`Hand #${String(detail.hand.handNumber).padStart(3, '0')}`}
                eyebrow="RECORDED EVENT STREAM"
                action={
                  <span className="subtle">
                    {detail.hand.status}
                    {detail.hand.status === 'complete' && detail.hand.profit === null
                      ? ' · unverified result'
                      : ''}
                  </span>
                }
              >
                <PokerTable table={table} label="RECORDED SNAPSHOT" />
                <div className="replay-controls">
                  <div className="replay-event">
                    <strong>{event?.type.replaceAll('_', ' ') ?? 'No recorded events'}</strong>
                    <span>{event ? time(event.receivedAt) : 'Events were not retained'}</span>
                  </div>
                  <input
                    aria-label="Replay event"
                    type="range"
                    min="0"
                    max={Math.max(0, detail.events.length - 1)}
                    value={cursor}
                    onChange={(event) => setCursor(Number(event.target.value))}
                    disabled={!detail.events.length}
                  />
                  <div className="replay-buttons">
                    <button
                      className="button compact secondary"
                      onClick={() => setCursor((value) => Math.max(0, value - 1))}
                      disabled={cursor === 0}
                    >
                      Previous event
                    </button>
                    <span>
                      {detail.events.length ? cursor + 1 : 0} / {detail.events.length}
                    </span>
                    <button
                      className="button compact secondary"
                      onClick={() =>
                        setCursor((value) => Math.min(detail.events.length - 1, value + 1))
                      }
                      disabled={cursor >= detail.events.length - 1}
                    >
                      Next event
                    </button>
                  </div>
                  <p className="annotation">
                    The table uses only events up to this cursor. Missing values stay unknown.
                  </p>
                  {detail.hand.status === 'complete' && detail.hand.profit === null && (
                    <p className="annotation">
                      This hand ended, but its recorded data is insufficient to verify profit. It is
                      excluded from performance metrics.
                    </p>
                  )}
                </div>
              </Panel>
              <Panel
                title="Decision trace"
                eyebrow="VISIBLE INPUT → CHOICE → EXECUTION"
                action={
                  detail.decisions.length ? (
                    <label className="sr-select">
                      Decision
                      <select
                        aria-label="Decision"
                        value={decision?.id ?? ''}
                        onChange={(event) => setDecisionId(event.target.value)}
                      >
                        {detail.decisions.map((item, index) => (
                          <option key={item.id} value={item.id}>
                            {index + 1}. {item.street} · {item.source}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null
                }
              >
                {decision ? (
                  <Decision decision={decision} />
                ) : (
                  <Empty title="No decision trace">
                    This hand has no recorded model decisions.
                  </Empty>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>
    </>
  );
}
