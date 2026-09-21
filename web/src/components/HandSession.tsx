import { useEffect, useState } from 'react';
import type { LiveDecisions, RuntimeView } from '../../../src/shared/api';
import { api, message, time } from '../api';
import { Decision } from './Decision';
import { Empty, ErrorNotice, Panel, Status } from './UI';
import './decision-analysis.css';

const phaseLabels = {
  reasoning: 'Analyzing the hand',
  jev: 'Jev is choosing the final action',
  completed: 'Decision recorded',
  fallback: 'Runtime selected a legal fallback',
  failed: 'Model decision failed · bot paused',
  submitted: 'Action submitted',
};

export function HandSession({ runtime }: { runtime: RuntimeView }) {
  const [record, setRecord] = useState<LiveDecisions | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const tableId = runtime.table?.tableId;
  const handId = runtime.table?.handId;
  const runId = runtime.runId;
  const session =
    record?.session?.tableId === tableId && record?.session?.handId === handId
      ? record?.session
      : null;
  const decisions = session ? record!.decisions : [];
  const selected = decisions.find((item) => item.id === selectedId) ?? decisions.at(-1);
  const progress =
    runtime.decision?.handId === handId && runtime.decision?.tableId === tableId
      ? runtime.decision
      : null;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRecord(null);
    setSelectedId(null);
    setError(null);
    if (!tableId || !handId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    async function refresh() {
      if (!active || inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        const value = await api<LiveDecisions>('/live/decisions');
        if (!active) return;
        if (value.session && (value.session.tableId !== tableId || value.session.handId !== handId))
          return;
        setRecord(value);
        setSelectedId((current) =>
          value.decisions.some((item) => item.id === current)
            ? current
            : (value.decisions.at(-1)?.id ?? null),
        );
        setError(null);
      } catch (reason) {
        if (active) setError(message(reason));
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 3000);
        }
      }
    }
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [tableId, handId, runId]);

  return (
    <Panel
      title="Hand session"
      eyebrow={
        runtime.strategy === 'jev-reasoning'
          ? 'REASONING → JEV → ACTION'
          : runtime.strategy === 'jev'
            ? 'JEV → ACTION'
            : 'BASELINE → ACTION'
      }
      className="hand-session-panel"
      action={
        <Status>
          {progress
            ? phaseLabels[progress.phase]
            : handId
              ? 'Following this hand'
              : 'Waiting for a hand'}
        </Status>
      }
    >
      <div className="hand-session-summary">
        <p>
          {handId
            ? `One hand, one session · ${session?.turnCount ?? decisions.length} recorded turns`
            : 'A new decision session opens with the next hand.'}
        </p>
        {session && <span>{session.id}</span>}
        {progress && (
          <p className="annotation" role="status">
            {phaseLabels[progress.phase]} · updated {time(progress.updatedAt)}
          </p>
        )}
      </div>
      <ErrorNotice error={error} />
      {loading && !selected ? (
        <p className="hand-session-loading" role="status">
          Loading the decision session…
        </p>
      ) : !selected ? (
        <Empty
          title={
            progress?.phase === 'reasoning' || progress?.phase === 'jev'
              ? 'The next choice is being prepared'
              : 'No decisions recorded for this hand yet'
          }
        >
          Saved decisions appear automatically. Text is shown only after it has been recorded.
        </Empty>
      ) : (
        <>
          <div className="hand-session-turns" role="group" aria-label="Session turns">
            {decisions.map((decision, index) => (
              <button
                className={`hand-session-turn ${decision.id === selected.id ? 'selected' : ''}`}
                key={decision.id}
                aria-pressed={decision.id === selected.id}
                onClick={() => setSelectedId(decision.id)}
              >
                <strong>Turn {index + 1}</strong>
                <span>
                  {decision.street} · {decision.status}
                </span>
              </button>
            ))}
          </div>
          <Decision decision={selected} />
        </>
      )}
    </Panel>
  );
}
