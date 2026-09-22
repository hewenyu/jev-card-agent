import { useEffect, useState } from 'react';
import type { EvaluationView } from '../../../src/shared/api';
import { api, dollars, message, number, policyLabel, time } from '../api';
import { Empty, ErrorNotice, Panel, Status } from '../components/UI';
import { AsyncResearch } from '../components/AsyncResearch';

export function Experiments({ openDecision }: { openDecision: (decisionId: string) => void }) {
  const [evaluations, setEvaluations] = useState<EvaluationView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const items = await api<EvaluationView[]>('/evaluations');
        if (!active) return;
        setEvaluations(items);
        setSelected((current) =>
          items.some((item) => item.id === current) ? current : (items[0]?.id ?? null),
        );
        setError(null);
      } catch (reason) {
        if (active) setError(message(reason));
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  const result = evaluations.find((item) => item.id === selected);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">COMPARE CHOICES, NOT COUNTERFACTUAL PROFITS</p>
          <h1>The choices, compared.</h1>
          <p className="subtle">
            Explore recorded evaluations of different policies on the same historical decisions.
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      <AsyncResearch />
      <div className="experiments-grid">
        <Panel title="Evaluation history" eyebrow="IMMUTABLE INPUTS">
          {loading ? (
            <div className="loading-state">Loading evaluations…</div>
          ) : !evaluations.length ? (
            <Empty title="No evaluations published yet">
              Completed comparisons will appear here when they are available.
            </Empty>
          ) : (
            <div className="evaluation-list">
              {evaluations.map((item) => (
                <button
                  className={`evaluation-item ${item.id === selected ? 'selected' : ''}`}
                  key={item.id}
                  onClick={() => setSelected(item.id)}
                >
                  <div>
                    <strong>{policyLabel(item.strategy)}</strong>
                    <span>{item.samples} samples</span>
                  </div>
                  <small>{time(item.createdAt)}</small>
                  <div>
                    <span>Action agreement</span>
                    <strong>
                      {item.samples ? Math.round((item.agreements / item.samples) * 100) : 0}%
                    </strong>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Comparison results" eyebrow="SAME INFORMATION · DIFFERENT POLICY">
          {!result ? (
            <Empty title="Select an evaluation">
              A completed comparison shows the original and alternative choices.
            </Empty>
          ) : (
            <>
              <div className="evaluation-metrics">
                <div>
                  <span>Samples</span>
                  <strong>{result.samples}</strong>
                </div>
                <div>
                  <span>Agreements</span>
                  <strong>{result.agreements}</strong>
                </div>
                <div>
                  <span>Errors</span>
                  <strong>{result.errors}</strong>
                </div>
                <div>
                  <span>Cost estimate</span>
                  <strong>{dollars(result.costUsd)}</strong>
                </div>
              </div>
              <p className="annotation evaluation-note">
                Mean response: {number(result.meanLatencyMs)} ms. Agreement measures consistency
                between policies, not correctness. Alternative choices do not have measured profits.
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Decision</th>
                      <th>Original</th>
                      <th>Alternative</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, index) => (
                      <tr key={`${row.decisionId}-${index}`}>
                        <td>
                          <button className="row-link" onClick={() => openDecision(row.decisionId)}>
                            View #{index + 1}
                          </button>
                        </td>
                        <td>{row.original ?? '—'}</td>
                        <td>{row.alternative ?? '—'}</td>
                        <td>
                          <Status>{row.status}</Status>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
