// Explicit paid diagnostic, never joins the Arena. Build first; load keys via node --env-file.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContext, buildCandidates, createInitialState } from '../dist/core/index.js';
import { JevProvider } from '../dist/policies/jev.js';
import { Store } from '../dist/storage/store.js';
import { LedgerMeter } from '../dist/storage/provider-meter.js';

if (!process.env.JEV_API_KEY) throw new Error('Set JEV_API_KEY in the private environment');
const cases = JSON.parse(
  readFileSync(new URL('../tests/fixtures/harness-scenarios.json', import.meta.url), 'utf8'),
);
const directory = process.env.HARNESS_REPORT_DIR || 'data/harness-probes';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const id = new Date().toISOString().replaceAll(':', '-');
const store = new Store(join(directory, 'usage.sqlite'));
const provider = new JevProvider({
  apiKey: process.env.JEV_API_KEY,
  baseUrl: process.env.JEV_BASE_URL,
  model: process.env.JEV_MODEL,
  timeoutMs: 10000,
  meter: new LedgerMeter(store, `synthetic-harness-${id}`),
});
const report = {
  id,
  suite: cases.version,
  evidence: 'Synthetic diagnostic actions only, no measured profit or Arena submissions',
  rows: [],
};
try {
  for (const scenario of cases.scenarios) {
    const state = {
      ...createInitialState(),
      ...cases.baseState,
      ...scenario.state,
      handId: scenario.id,
    };
    const context = buildContext(state);
    const binding = store.pinKnowledge(state, new Date().toISOString());
    const { opponents: _opponents, cards: _cards, ...snapshot } = binding.snapshot;
    context.knowledge = { pin: binding.pin, snapshot };
    const candidates = buildCandidates(state);
    try {
      const proposal = await provider.decide(context, candidates, {
        signal: AbortSignal.timeout(40000),
      });
      const action = candidates.find((candidate) => candidate.id === proposal.candidateId)?.action;
      const passed = scenario.expected.acceptableActions.includes(action);
      report.rows.push({
        id: scenario.id,
        passed,
        action,
        context,
        candidates,
        proposal,
        expected: scenario.expected,
      });
      console.log(
        JSON.stringify({ id: scenario.id, passed, action, latencyMs: proposal.latencyMs }),
      );
    } catch (error) {
      report.rows.push({
        id: scenario.id,
        passed: false,
        error: error.code || error.message,
        attempts: error.attempts,
      });
      console.log(
        JSON.stringify({ id: scenario.id, passed: false, error: error.code || error.message }),
      );
    }
    writeFileSync(join(directory, `${id}.json`), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  }
  const passed = report.rows.filter((row) => row.passed).length;
  console.log(
    JSON.stringify({ passed, total: report.rows.length, report: join(directory, `${id}.json`) }),
  );
  if (passed !== report.rows.length) process.exitCode = 1;
} finally {
  store.close();
}
