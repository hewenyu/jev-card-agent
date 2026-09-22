import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePairedEvaluation, runPairedEvaluation } from '../src/evaluation/async-research.js';
import { AdviceStore } from '../src/knowledge/advice-store.js';
import { Store } from '../src/storage/store.js';
import { JevProvider } from '../src/policies/jev.js';
import { evaluationHands, publishFixture } from './helpers/research-fixture.js';

const clean: Array<() => void> = [];
afterEach(() => {
  for (const f of clean.splice(0).reverse()) f();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-paired-'));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'raw.sqlite'));
  clean.push(() => store.close());
  const advice = new AdviceStore(join(dir, 'research.sqlite'));
  clean.push(() => advice.close());
  evaluationHands(store);
  publishFixture(advice);
  return {
    rawPath: store.filename,
    researchPath: join(dir, 'research.sqlite'),
    runId: 'controlled',
    model: 'jev-1.13.0',
  };
}
describe('explicit asynchronous advice paired experiments', () => {
  it('prepares disjoint frozen held-out hands with exactly advice as the request difference and no calls', () => {
    const options = fixture();
    const holdout = preparePairedEvaluation(options);
    const development = preparePairedEvaluation({ ...options, partition: 'development' });
    expect(holdout.experiment).toBe('posthoc_time_split');
    expect(holdout.samples.length).toBeGreaterThan(0);
    expect(holdout.samples.every((s) => s.adviceMatched)).toBe(true);
    expect(
      development.samples.every((s) => !holdout.samples.some((h) => h.handId === s.handId)),
    ).toBe(true);
    expect(holdout.samples.every((s) => !holdout.evidenceHandIds.includes(s.handId))).toBe(true);
    for (const sample of holdout.samples) {
      const { advice: _a, ...a } = sample.a;
      const { advice: _c, ...c } = sample.c;
      expect(c).toEqual(a);
      expect(sample.cInputBytes).toBeGreaterThan(sample.aInputBytes);
    }
  });
  it('runs both projections through the actual Jev adapter, records calls and never assigns alternate profit', async () => {
    const plan = preparePairedEvaluation({ ...fixture(), limit: 2 });
    const requests: unknown[] = [];
    const provider = new JevProvider({
      apiKey: 'controlled-key',
      model: plan.requestedModel,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const ids = Object.keys(body.questions.action.criteria);
        return Response.json({
          model: plan.requestedModel,
          usage: { input_tokens: 100, output_tokens: 0 },
          answers: {
            action: {
              type: 'choice',
              choice: ids[0],
              confidence: 1,
              probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0])),
            },
          },
        });
      },
    });
    const result = await runPairedEvaluation(plan, provider);
    expect(requests, result.rows.map((r) => r.error).join(', ')).toHaveLength(4);
    expect(result.failedDecisions).toBe(0);
    expect(result.providerCalls).toBe(4);
    expect(result.rows.every((r) => r.requestHash?.length === 64)).toBe(true);
    expect(result).not.toHaveProperty('profit');
    const changedQuestions = await runPairedEvaluation(plan, {
      async decide(context, candidates, options) {
        const proposal = await provider.decide(context, candidates, options);
        proposal.request!.questions = { extra: 'unplanned model question' };
        return proposal;
      },
    });
    expect(changedQuestions.failedDecisions).toBe(4);
    expect(
      changedQuestions.rows.every((row) => row.error?.includes('Actual request differs')),
    ).toBe(true);
    plan.samples[0]!.a.pot = 99999;
    await expect(runPairedEvaluation(plan, provider)).rejects.toThrow('integrity');
    expect(requests).toHaveLength(8);
  });
});
