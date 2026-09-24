import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { digest, type Json } from 'duelloop';
import { z } from 'zod';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const jsonObject = z.record(z.string(), z.json());
const street = z.enum(['preflop', 'flop', 'turn', 'river']);
const candidateSchema = z.strictObject({
  id,
  action: z.enum(['fold', 'check', 'call', 'raise', 'all_in']),
  amount: z.number().finite().nonnegative().optional(),
  label: z.string().min(1),
});
const requestSchema = z.strictObject({
  model: id,
  state: jsonObject,
  questions: z.strictObject({
    action: z.strictObject({
      type: z.literal('choice'),
      instructions: z.json(),
      criteria: z.record(z.string(), jsonObject),
    }),
  }),
});
export const replaySampleSchema = z.strictObject({
  decisionId: id,
  runId: id,
  handId: id,
  tableId: id,
  street,
  originalAt: timestamp,
  originalChoice: id,
  originalModel: id,
  originalLatencyMs: z.number().finite().nonnegative(),
  inputHash: hash,
  request: requestSchema,
  candidates: z.array(candidateSchema).min(1).max(32),
});
export type ReplaySample = z.infer<typeof replaySampleSchema>;
const outcomeSchema = z.strictObject({
  handId: id,
  completedAt: timestamp,
  netChips: z.number().finite(),
  bigBlind: z.number().finite().positive(),
});
const planSchema = z.strictObject({
  schemaVersion: z.literal('duelloop-poker-shadow-v1'),
  preparedAt: timestamp,
  sourceRunId: id,
  sourceMode: z.literal('live'),
  selection: z.literal('street_round_robin_then_chronological'),
  scanned: z.number().int().nonnegative(),
  scanLimitReached: z.boolean(),
  excluded: z.record(z.string(), z.number().int().nonnegative()),
  samples: z.array(replaySampleSchema).min(1).max(1000),
  historicalOutcomes: z.array(outcomeSchema).max(1000),
  planHash: hash,
});
export type ReplayPlan = z.infer<typeof planSchema>;

// Reject source formats that predate the current visible-state projection. Do not
// silently reconstruct old input or strip fields and then call it an exact replay.
const stateKeys = new Set([
  'harness',
  'knowledge',
  'approvedAdvice',
  'street',
  'holeCards',
  'board',
  'heroSeat',
  'dealerSeat',
  'bigBlind',
  'smallBlind',
  'seats',
  'historyIncomplete',
  'currentHandActions',
  'opponentMemory',
  'session',
  'evidencePolicy',
]);
function assertVisibleRequest(sample: ReplaySample): void {
  const state = sample.request.state;
  if (Object.keys(state).some((key) => !stateKeys.has(key)))
    throw new Error('unsupported_archived_state');
  const cards = (value: Json, lengths: number[]) =>
    Array.isArray(value) &&
    lengths.includes(value.length) &&
    value.every((card) => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card));
  if (
    state.street !== sample.street ||
    state.historyIncomplete !== false ||
    !cards(state.holeCards!, [2]) ||
    !cards(state.board!, [0, 3, 4, 5])
  )
    throw new Error('incomplete_archived_state');
  const board = state.board as string[],
    hole = state.holeCards as string[];
  const expected = { preflop: 0, flop: 3, turn: 4, river: 5 }[sample.street];
  if (board.length !== expected || new Set([...board, ...hole]).size !== board.length + hole.length)
    throw new Error('incomplete_archived_state');
  const criteria = sample.request.questions.action.criteria;
  const ids = new Set(sample.candidates.map((candidate) => candidate.id));
  if (
    ids.size !== sample.candidates.length ||
    !ids.has(sample.originalChoice) ||
    Object.keys(criteria).length !== ids.size ||
    Object.keys(criteria).some((key) => !ids.has(key))
  )
    throw new Error('candidate_mismatch');
  for (const candidate of sample.candidates) {
    const priced = criteria[candidate.id]!;
    if (
      priced.action !== candidate.action ||
      (candidate.amount !== undefined && priced.raiseToChips !== candidate.amount)
    )
      throw new Error('candidate_price_mismatch');
  }
  if (digest(sample.request) !== sample.inputHash) throw new Error('request_hash_mismatch');
  const inspect = (value: Json): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (/^(authorization|api_?key|turn_?token|access_?token|secret|password)$/i.test(key))
        throw new Error('credential_field_in_request');
      inspect(child);
    }
  };
  inspect(sample.request as unknown as Json);
}

export function validateReplayPlan(value: unknown): ReplayPlan {
  const plan = planSchema.parse(value);
  const { planHash, ...content } = plan;
  if (digest(content) !== planHash) throw new Error('Replay plan integrity check failed');
  const ids = new Set<string>();
  for (const sample of plan.samples) {
    if (sample.runId !== plan.sourceRunId || ids.has(sample.decisionId))
      throw new Error('Invalid or duplicate replay identity');
    if (Date.parse(sample.originalAt) > Date.parse(plan.preparedAt))
      throw new Error('Future source decision');
    assertVisibleRequest(sample);
    ids.add(sample.decisionId);
  }
  const hands = new Set(plan.samples.map((sample) => sample.handId));
  const outcomes = new Set<string>();
  for (const outcome of plan.historicalOutcomes) {
    if (
      !hands.has(outcome.handId) ||
      outcomes.has(outcome.handId) ||
      Date.parse(outcome.completedAt) > Date.parse(plan.preparedAt) ||
      plan.samples.some(
        (s) =>
          s.handId === outcome.handId && Date.parse(s.originalAt) > Date.parse(outcome.completedAt),
      )
    )
      throw new Error('Invalid historical outcome identity or time');
    outcomes.add(outcome.handId);
  }
  return plan;
}

/** Read-only snapshot; outcomes are a separate collection and never model features. */
export function prepareReplayPlan(options: {
  rawPath: string;
  runId: string;
  limit?: number;
}): ReplayPlan {
  const limit = options.limit ?? 24;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Replay limit must be an integer from 1 to 1000');
  const db = new DatabaseSync(options.rawPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const run = db.prepare('SELECT mode FROM runs WHERE id=?').get(options.runId);
    if (run?.mode !== 'live') throw new Error('Select an existing live source run');
    const rows = db
      .prepare(
        `SELECT d.id,d.run_id,d.hand_id,d.street,d.created_at,d.proposal,
      d.candidates,d.selected,d.model,d.status,d.source,d.latency_ms,d.fallback_reason,
      h.table_id,h.complete,h.status AS hand_status,h.ended_at,h.profit,h.big_blind
      FROM decisions d JOIN hands h ON h.id=d.hand_id AND h.run_id=d.run_id
      WHERE d.run_id=? ORDER BY d.created_at,d.id LIMIT 10001`,
      )
      .all(options.runId);
    const excluded: Record<string, number> = {};
    const exclude = (reason: string) => {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
    };
    const eligible: ReplaySample[] = [];
    const outcomes = new Map<string, z.infer<typeof outcomeSchema>>();
    for (const row of rows.slice(0, 10000)) {
      if (row.status !== 'accepted' || row.source !== 'jev' || row.fallback_reason) {
        exclude('not_accepted_pure_model_action');
        continue;
      }
      if (!row.complete || row.hand_status !== 'complete' || !row.ended_at) {
        exclude('incomplete_hand');
        continue;
      }
      try {
        const proposal = JSON.parse(String(row.proposal)) as Record<string, unknown>;
        const request = requestSchema.parse(proposal.request);
        if (
          typeof proposal.requestHash !== 'string' ||
          createHash('sha256').update(JSON.stringify(proposal.request)).digest('hex') !==
            proposal.requestHash
        )
          throw new Error('archived_request_hash_mismatch');
        const sample = replaySampleSchema.parse({
          decisionId: row.id,
          runId: row.run_id,
          handId: row.hand_id,
          tableId: row.table_id,
          street: row.street,
          originalAt: row.created_at,
          originalChoice: row.selected,
          originalModel: row.model,
          originalLatencyMs: row.latency_ms,
          inputHash: digest(request),
          request,
          candidates: JSON.parse(String(row.candidates)),
        });
        assertVisibleRequest(sample);
        const completedAt = timestamp.parse(row.ended_at);
        if (Date.parse(completedAt) < Date.parse(sample.originalAt))
          throw new Error('invalid_outcome_time');
        if (
          typeof row.profit === 'number' &&
          typeof row.big_blind === 'number' &&
          row.big_blind > 0
        )
          outcomes.set(
            sample.handId,
            outcomeSchema.parse({
              handId: sample.handId,
              completedAt,
              netChips: row.profit,
              bigBlind: row.big_blind,
            }),
          );
        eligible.push(sample);
      } catch (error) {
        exclude(
          error instanceof z.ZodError || error instanceof SyntaxError
            ? 'unsupported_archived_input'
            : error instanceof Error
              ? error.message
              : 'invalid_archived_input',
        );
      }
    }
    const buckets = ['preflop', 'flop', 'turn', 'river'].map((phase) =>
      eligible.filter((s) => s.street === phase),
    );
    const samples: ReplaySample[] = [];
    for (let index = 0; samples.length < Math.min(limit, eligible.length); index++) {
      for (const bucket of buckets) {
        if (bucket[index] && samples.length < limit) samples.push(bucket[index]!);
      }
    }
    samples.sort(
      (a, b) =>
        Date.parse(a.originalAt) - Date.parse(b.originalAt) ||
        a.decisionId.localeCompare(b.decisionId),
    );
    if (!samples.length)
      throw new Error(`No eligible archived requests: ${JSON.stringify(excluded)}`);
    excluded.outside_sample_limit = eligible.length - samples.length;
    const hands = new Set(samples.map((sample) => sample.handId));
    const content = {
      schemaVersion: 'duelloop-poker-shadow-v1' as const,
      preparedAt: new Date().toISOString(),
      sourceRunId: options.runId,
      sourceMode: 'live' as const,
      selection: 'street_round_robin_then_chronological' as const,
      scanned: Math.min(rows.length, 10000),
      scanLimitReached: rows.length > 10000,
      excluded,
      samples,
      historicalOutcomes: [...outcomes.values()].filter((outcome) => hands.has(outcome.handId)),
    };
    return validateReplayPlan({ ...content, planHash: digest(content) });
  } finally {
    db.close();
  }
}
