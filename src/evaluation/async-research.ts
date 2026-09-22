import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Candidate,
  DecisionContext,
  Policy,
  ProviderAttempt,
  RawMessage,
} from '../core/types.js';
import { applyAdvice } from '../core/advice.js';
import { projectJevState, candidateCriteria, POKER_INSTRUCTIONS } from '../core/harness.js';
import { baselineSnapshot } from '../knowledge/store.js';
import { AdviceStore } from '../knowledge/advice-store.js';
import { hashAdviceBundle } from '../knowledge/advice-validator.js';
import type { AdviceBundle } from '../knowledge/advice-types.js';
import { ProviderError } from '../policies/metering.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface PairedSample {
  decisionId: string;
  handId: string;
  originalDecisionAt: string;
  originalChoice: string | null;
  candidates: Candidate[];
  a: DecisionContext;
  c: DecisionContext;
  aStateHash: string;
  cStateHash: string;
  aRequestHash: string;
  cRequestHash: string;
  aInputBytes: number;
  cInputBytes: number;
  adviceMatched: boolean;
}
export interface PairedPlan {
  schemaVersion: 'async-paired-v1';
  planId: string;
  planHash: string;
  preparedAt: string;
  experiment: 'posthoc_time_split';
  partition: 'development' | 'holdout';
  requestedModel: string;
  sourceRunId: string;
  researchCutoff: string;
  publicationIds: string[];
  publicationHashes: string[];
  evidenceHandIds: string[];
  excluded: Record<string, number>;
  samples: PairedSample[];
  limitations: string[];
}
function emptyBundle(bundle: AdviceBundle): AdviceBundle {
  const { bundleHash: _hash, ...content } = { ...bundle, mode: 'off' as const, publications: [] };
  return { ...content, bundleHash: hashAdviceBundle(content) };
}
/** No provider, runtime, writable history or Arena connection is constructed by prepare. */
export function preparePairedEvaluation(options: {
  rawPath: string;
  researchPath: string;
  runId: string;
  model: string;
  limit?: number;
  partition?: 'development' | 'holdout';
}): PairedPlan {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Pair count must be 1..100');
  const raw = new DatabaseSync(options.rawPath, { readOnly: true });
  const advice = new AdviceStore(options.researchPath, { readOnly: true });
  try {
    const now = new Date().toISOString();
    const rows = raw
      .prepare(
        `SELECT d.*,h.started_at AS hand_start,h.complete AS hand_complete
      FROM decisions d JOIN hands h ON h.id=d.hand_id AND h.run_id=d.run_id
      WHERE d.run_id=? ORDER BY d.created_at,d.id LIMIT 10000`,
      )
      .all(options.runId);
    const bundle = advice.bundle({
      mode: 'live',
      basePolicyVersion: baselineSnapshot().version,
      admissibleAt: now,
    });
    if (!bundle.publications.length)
      throw new Error('No approved, currently valid advice for the frozen base policy');
    const evidence = bundle.publications.map((p) => advice.getProposal(p.proposalId)!.batch);
    const evidenceHands = new Set(evidence.flatMap((b) => b.eligibleHandIds));
    for (const metric of bundle.supportMetrics ?? [])
      for (const id of metric.handIds) evidenceHands.add(id);
    const cutoff = evidence.reduce((a, b) => (a > b.cutoff ? a : b.cutoff), '');
    const plan: Omit<PairedPlan, 'planHash'> = {
      schemaVersion: 'async-paired-v1',
      planId: randomUUID(),
      preparedAt: now,
      experiment: 'posthoc_time_split',
      partition: options.partition ?? 'holdout',
      requestedModel: options.model,
      sourceRunId: options.runId,
      researchCutoff: '',
      publicationIds: [],
      publicationHashes: [],
      evidenceHandIds: [],
      excluded: {},
      samples: [],
      limitations: [
        'Advice was published after the historical run. This is a posthoc time-split experiment, not an original-run replay.',
        'A and C use the same facts, statistics, candidates and Jev configuration. Only approved advice differs.',
        'Historical outcomes are never assigned to alternative actions. Choice differences do not prove profitability.',
        'Development and holdout hands are disjoint by a fixed hand hash. Holdout results must not be used to tune advice and remain labelled unseen.',
      ],
    };
    const seen = new Set<string>();
    const exclude = (reason: string) => {
      plan.excluded[reason] = (plan.excluded[reason] ?? 0) + 1;
    };
    for (const row of rows) {
      if (plan.samples.length >= limit) break;
      const context = JSON.parse(String(row.context)) as DecisionContext;
      if (
        !Number.isFinite(Date.parse(String(row.hand_start))) ||
        !Number.isFinite(Date.parse(String(row.created_at))) ||
        context.handId !== row.hand_id
      ) {
        exclude('invalid_frozen_identity_or_time');
        continue;
      }
      const candidates = JSON.parse(String(row.candidates)) as Candidate[];
      if (!candidates.length || new Set(candidates.map((c) => c.id)).size !== candidates.length) {
        exclude('invalid_candidates');
        continue;
      }
      if (
        !context.knowledge ||
        context.historyIncomplete ||
        !row.hand_complete ||
        context.holeCards.length !== 2
      ) {
        exclude('incomplete_frozen_context');
        continue;
      }
      const handId = String(row.hand_id);
      if (seen.has(handId)) {
        exclude('same_hand');
        continue;
      }
      const partition =
        parseInt(hash(handId).slice(0, 8), 16) % 5 === 0 ? 'development' : 'holdout';
      if (partition !== plan.partition) {
        exclude('other_partition');
        continue;
      }
      if (
        evidenceHands.has(handId) ||
        Date.parse(String(row.hand_start)) <= Date.parse(cutoff) ||
        Date.parse(String(row.created_at)) <= Date.parse(cutoff) ||
        (bundle.supportMetrics ?? []).some(
          (metric) => Date.parse(metric.availableAt) >= Date.parse(String(row.hand_start)),
        )
      ) {
        exclude('research_evidence_overlap');
        continue;
      }
      const a = structuredClone(context);
      const c = structuredClone(context);
      applyAdvice(a, emptyBundle(bundle), now);
      applyAdvice(c, bundle, now);
      const stateA = projectJevState(a);
      const stateC = projectJevState(c);
      const request = (state: RawMessage) => ({
        model: options.model,
        state,
        questions: {
          action: {
            type: 'choice',
            instructions: POKER_INSTRUCTIONS,
            criteria: candidateCriteria(a, JSON.parse(String(row.candidates)) as Candidate[]),
          },
        },
      });
      const stateHashA = hash(stateA),
        stateHashC = hash(stateC);
      plan.samples.push({
        decisionId: String(row.id),
        handId,
        originalDecisionAt: String(row.created_at),
        originalChoice: row.selected == null ? null : String(row.selected),
        candidates: JSON.parse(String(row.candidates)) as Candidate[],
        a,
        c,
        aStateHash: stateHashA,
        cStateHash: stateHashC,
        aRequestHash: hash(request(stateA)),
        cRequestHash: hash(request(stateC)),
        aInputBytes: Buffer.byteLength(JSON.stringify(request(stateA))),
        cInputBytes: Buffer.byteLength(JSON.stringify(request(stateC))),
        adviceMatched: stateHashA !== stateHashC,
      });
      seen.add(handId);
      plan.researchCutoff = cutoff;
      plan.publicationIds = bundle.publications.map((p) => p.publicationId);
      plan.publicationHashes = bundle.publications.map((p) => p.contentHash);
      plan.evidenceHandIds = [...evidenceHands].sort();
    }
    if (!plan.samples.length)
      throw new Error('No eligible held-out decisions after the research cutoff');
    return { ...plan, planHash: hash(plan) };
  } finally {
    raw.close();
    advice.close();
  }
}
export interface PairedResultRow {
  decisionId: string;
  handId: string;
  group: 'A' | 'C';
  selected: string | null;
  status: 'succeeded' | 'failed';
  error: string | null;
  latencyMs: number;
  actualModel: string | null;
  requestHash: string | null;
  request?: RawMessage;
  attempts: ProviderAttempt[];
}
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}
/** Caller explicitly authorizes model calls and supplies a metered Jev policy. No bot controls. */
export async function runPairedEvaluation(plan: PairedPlan, policy: Policy, timeoutMs = 40000) {
  const { planHash, ...content } = plan;
  if (planHash !== hash(content)) throw new Error('Prepared experiment integrity check failed');
  const rows: PairedResultRow[] = [];
  for (const [index, sample] of plan.samples.entries()) {
    for (const group of (index % 2 ? ['C', 'A'] : ['A', 'C']) as Array<'A' | 'C'>) {
      const context = structuredClone(group === 'A' ? sample.a : sample.c);
      if (
        hash(projectJevState(context)) !== (group === 'A' ? sample.aStateHash : sample.cStateHash)
      )
        throw new Error('Prepared Jev projection changed; prepare again');
      const started = performance.now();
      try {
        const proposal = await policy.decide(context, sample.candidates, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (
          proposal.source !== 'jev' ||
          !sample.candidates.some((c) => c.id === proposal.candidateId)
        )
          throw new Error('Paired evaluation requires a legal Jev choice');
        if (
          proposal.request?.model !== plan.requestedModel ||
          !proposal.request?.state ||
          hash(proposal.request.state) !==
            (group === 'A' ? sample.aStateHash : sample.cStateHash) ||
          hash(proposal.request) !== (group === 'A' ? sample.aRequestHash : sample.cRequestHash)
        )
          throw new Error('Actual request differs from the prepared experiment');
        rows.push({
          decisionId: sample.decisionId,
          handId: sample.handId,
          group,
          selected: proposal.candidateId,
          status: 'succeeded',
          error: null,
          latencyMs: performance.now() - started,
          actualModel: proposal.model ?? null,
          requestHash: hash(proposal.request),
          request: proposal.request,
          attempts: proposal.attempts ?? [],
        });
      } catch (error) {
        rows.push({
          decisionId: sample.decisionId,
          handId: sample.handId,
          group,
          selected: null,
          status: 'failed',
          error:
            error instanceof ProviderError
              ? error.code
              : error instanceof Error
                ? error.message
                : 'Evaluation failed',
          latencyMs: performance.now() - started,
          actualModel: null,
          requestHash: null,
          attempts:
            error instanceof ProviderError
              ? (error.attempts ?? (error.attempt ? [error.attempt] : []))
              : [],
        });
      }
    }
  }
  const attempts = rows.flatMap((r) => r.attempts);
  return {
    experiment: plan.experiment,
    partition: plan.partition,
    planId: plan.planId,
    planHash,
    completedAt: new Date().toISOString(),
    logicalDecisions: rows.length,
    providerCalls: attempts.length,
    failedDecisions: rows.filter((r) => r.status === 'failed').length,
    adviceMatched: plan.samples.filter((s) => s.adviceMatched).length,
    changedChoices: plan.samples.filter((s) => {
      const pair = rows.filter((r) => r.decisionId === s.decisionId);
      return pair.every((r) => r.status === 'succeeded') && pair[0]!.selected !== pair[1]!.selected;
    }).length,
    unknownUsageCalls: attempts.filter((a) => a.usage === null).length,
    latency: Object.fromEntries(
      ['A', 'C'].map((group) => {
        const values = rows.filter((r) => r.group === group).map((r) => r.latencyMs);
        return [
          group,
          {
            n: values.length,
            p50: percentile(values, 0.5),
            p95: percentile(values, 0.95),
            p99: percentile(values, 0.99),
          },
        ];
      }),
    ),
    rows,
    limitations: plan.limitations,
  };
}
