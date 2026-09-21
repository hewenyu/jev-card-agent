import { useEffect, useState } from 'react';
import type { EvaluationView, RunSummary, StrategyName } from '../../../src/shared/api';
import { api, dollars, message, number, policyLabel, time } from '../api';
import { Empty, ErrorNotice, Panel, SourceBadge, Status } from '../components/UI';

export function Experiments({
  runs,
  selectedRunId,
  canControl,
  jevConfigured,
  reasoningConfigured,
  openDecision,
}: {
  runs: RunSummary[];
  selectedRunId: string;
  canControl: boolean;
  jevConfigured: boolean;
  reasoningConfigured: boolean;
  openDecision: (decisionId: string) => void;
}) {
  const [evaluations, setEvaluations] = useState<EvaluationView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<StrategyName>('baseline');
  const [limit, setLimit] = useState('20');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api<EvaluationView[]>('/evaluations')
      .then((items) => {
        if (active) {
          setEvaluations(items);
          setSelected(items[0]?.id ?? null);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(message(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const result = evaluations.find((item) => item.id === selected);
  const run = runs.find((item) => item.id === selectedRunId);
  async function evaluate() {
    setBusy(true);
    setError(null);
    try {
      const value = await api<EvaluationView>('/evaluations', {
        runId: selectedRunId,
        strategy,
        limit: Number(limit),
      });
      setEvaluations((items) => [value, ...items.filter((item) => item.id !== value.id)]);
      setSelected(value.id);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">COMPARE CHOICES, NOT COUNTERFACTUAL PROFITS</p>
          <h1>Put decisions to the test.</h1>
          <p className="subtle">
            Re-run frozen inputs against another policy. Keep the original evidence intact.
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      <Panel title="New comparison" eyebrow="DECISION REPLAY">
        <form
          className="experiment-form"
          onSubmit={(event) => {
            event.preventDefault();
            void evaluate();
          }}
        >
          <div className="experiment-source">
            <span className="field-label">Source run</span>
            <strong>{run ? run.id.slice(0, 24) : 'Select a run in the header'}</strong>
            {run && <SourceBadge mode={run.mode} />}
          </div>
          <label className="field">
            Compare against
            <select
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as StrategyName)}
            >
              <option value="baseline">Rule baseline · local</option>
              <option value="jev" disabled={!jevConfigured}>
                Jev Choice · paid API
              </option>
              {reasoningConfigured && (
                <option value="jev-reasoning" disabled={!jevConfigured}>
                  Jev + reasoning · paid APIs
                </option>
              )}
            </select>
          </label>
          <label className="field">
            Sample limit
            <input
              type="number"
              min="1"
              max="100"
              value={limit}
              required
              onChange={(event) => setLimit(event.target.value)}
            />
          </label>
          <button
            className="button primary"
            type="submit"
            disabled={
              busy ||
              !run ||
              !canControl ||
              run.decisions === 0 ||
              (strategy !== 'baseline' && !jevConfigured) ||
              (strategy === 'jev-reasoning' && !reasoningConfigured)
            }
          >
            {busy ? 'Evaluating…' : 'Run comparison'}
          </button>
        </form>
        <p className="annotation experiment-note">
          {strategy === 'baseline'
            ? 'Baseline replay runs locally and makes no paid API calls.'
            : strategy === 'jev-reasoning'
              ? 'Jev requests reasoning only when needed, then reconsiders the legal choice. Both providers are metered.'
              : 'Jev replay makes paid API requests within the server’s evaluation budget.'}{' '}
          Alternative actions change future play; this comparison does not estimate alternative
          profits.
        </p>
      </Panel>
      <div className="experiments-grid">
        <Panel title="Evaluation history" eyebrow="IMMUTABLE INPUTS">
          {loading ? (
            <div className="loading-state">Loading evaluations…</div>
          ) : !evaluations.length ? (
            <Empty title="Your first comparison awaits">
              Run a baseline comparison to inspect where the policies agree.
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
                between policies, not correctness.
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
