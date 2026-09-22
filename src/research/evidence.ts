import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { baselineSnapshot } from '../knowledge/store.js';
import { researchRoster, type ResearchRoster } from './identity.js';
import { actualInputFacts } from './input-facts.js';
import { opponentKey, researchBatchHash } from '../knowledge/advice-validator.js';
import {
  ResearchBatchSchema,
  type EvidenceExample,
  type EvidenceMetric,
  type ResearchBatchV2,
} from './contracts.js';

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const ACTIONS = ['fold', 'check', 'call', 'raise', 'all_in'];
type Raw = Record<string, unknown>;
const object = (v: unknown): Raw =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const cards = (v: unknown): string[] =>
  array(v)
    .filter((c): c is string => typeof c === 'string' && /^[2-9TJQKA][cdhs]$/.test(c))
    .slice(0, 5);
const known = (v: unknown, values: string[]): string | null =>
  typeof v === 'string' && values.includes(v) ? v : null;
function parse(v: unknown): Raw {
  try {
    return object(JSON.parse(String(v)));
  } catch {
    return {};
  }
}
interface Hand extends ResearchRoster {
  id: string;
  profit: number;
  eventId: number;
  availableAt: string;
  decisions: Raw[];
  result: Raw;
  board: string[];
  bigBlind: number;
  opponents: string[];
}
/** Whitelist, never recursive redaction: credentials, names and arbitrary model prose cannot enter. */
function visible(context: Raw, excludedSeats: number[]): Raw {
  const seats = array(context.seats).map(object);
  return {
    opponentAttributionExcludedSeats: excludedSeats,
    street: known(context.street, STREETS),
    heroSeat: number(context.heroSeat),
    dealerSeat: number(context.dealerSeat),
    pot: number(context.pot),
    toCall: number(context.toCall),
    effectiveStack: number(context.effectiveStack),
    bigBlind: number(context.bigBlind),
    board: cards(context.board),
    holeCards: cards(context.holeCards),
    historyIncomplete: context.historyIncomplete !== false,
    seats: seats.slice(0, 6).map((s) => ({
      seat: number(s.seat),
      opponentKey:
        typeof s.name === 'string' &&
        s.seat !== context.heroSeat &&
        !excludedSeats.includes(Number(s.seat))
          ? opponentKey(s.name)
          : null,
      stack: number(s.stack),
      bet: number(s.bet),
      inHand: typeof s.inHand === 'boolean' ? s.inHand : null,
      folded: typeof s.folded === 'boolean' ? s.folded : null,
    })),
    history: array(context.history)
      .slice(-12)
      .map(object)
      .map((a) => ({
        seat: number(a.seat),
        street: known(a.street, STREETS),
        action: known(a.action, ACTIONS),
        amount: number(a.amount),
        toCallBefore: number(a.toCallBefore),
      })),
    // Only previously visible decisions, without old natural-language analysis or external control data.
    session: array(object(context.session).previousTurns)
      .slice(-4)
      .map(object)
      .map((t) => ({
        street: known(t.street, STREETS),
        action: known(object(t.action).kind, ACTIONS),
        raiseToChips: number(object(t.action).raiseToChips),
      })),
  };
}
function postSettlement(hand: Hand): Raw {
  const result = hand.result;
  return {
    opponentAttributionExcludedSeats: hand.excludedSeats,
    profitChips: hand.profit,
    bigBlind: hand.bigBlind,
    board: hand.board,
    publicShownCards: Object.entries(object(result.shown_cards))
      .filter(([seat]) => /^[0-5]$/.test(seat))
      .map(([seat, value]) => ({ seat: Number(seat), cards: cards(value) })),
    actions: array(result.actions)
      .slice(-24)
      .map(object)
      .map((a) => ({
        seat: number(a.seat),
        street: known(a.street, STREETS),
        action: known(a.action, ACTIONS),
        amount: number(a.amount),
      })),
  };
}
/** Completed-window sampling includes ordinary hands from all observed outcome strata. */
function stratified(hands: Hand[], limit = 6): Hand[] {
  const groups = [
    hands.filter((h) => h.profit < 0),
    hands.filter((h) => h.profit > 0),
    hands.filter((h) => h.profit === 0),
  ];
  const selected: Hand[] = [];
  for (let i = 0; selected.length < limit && groups.some((g) => i < g.length); i++) {
    for (const group of groups) if (group[i] && selected.length < limit) selected.push(group[i]!);
  }
  return selected;
}
export class EvidenceBuilder {
  private readonly raw: DatabaseSync;
  constructor(path: string) {
    this.raw = new DatabaseSync(path, { readOnly: true });
    this.raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
  }
  /** Materialization is bounded and runs only in the research worker or explicit offline CLI. */
  batches(cutoff = new Date().toISOString()): ResearchBatchV2[] {
    const rows = this.raw
      .prepare(
        `SELECT h.*,e.id AS event_id,e.received_at,e.payload FROM hands h
      JOIN runs r ON r.id=h.run_id JOIN events e ON e.id=(SELECT MAX(x.id) FROM events x WHERE x.run_id=h.run_id AND x.hand_id=h.id AND x.type='hand_result' AND x.received_at<=?)
      WHERE r.mode='live' AND h.complete=1 AND h.profit IS NOT NULL AND h.big_blind>0 AND h.ended_at<=?
      AND NOT EXISTS (SELECT 1 FROM events later WHERE later.run_id=h.run_id AND later.hand_id=h.id AND (later.received_at>? OR json_extract(later.payload,'$.ts')>?))
      AND NOT EXISTS (SELECT 1 FROM decisions later_decision WHERE later_decision.run_id=h.run_id AND later_decision.hand_id=h.id AND later_decision.created_at>?)
      ORDER BY e.id DESC LIMIT 100`,
      )
      .all(cutoff, cutoff, cutoff, cutoff, cutoff);
    const hands: Hand[] = [];
    for (const row of rows) {
      const decisions = this.raw
        .prepare(
          `SELECT d.id,d.context,d.candidates,d.proposal,d.selected,d.status,d.source,d.created_at,(SELECT MAX(e.id) FROM events e WHERE e.hand_id=d.hand_id AND e.run_id=d.run_id AND e.received_at<=d.created_at) AS visible_event_id FROM decisions d WHERE d.hand_id=? AND d.run_id=? AND d.created_at<=? ORDER BY d.created_at DESC,d.id DESC LIMIT 16`,
        )
        .all(String(row.id), String(row.run_id), String(row.ended_at))
        .reverse() as Raw[];
      const contexts = decisions.map((d) => parse(d.context));
      const identityEvents = this.raw
        .prepare(
          "SELECT type,payload FROM events WHERE hand_id=? AND run_id=? AND table_id=? AND id<=? AND received_at>=? AND received_at<=? AND type IN ('table_state','table_joined','hand_start','player_joined','player_left') ORDER BY id",
        )
        .all(
          String(row.id),
          String(row.run_id),
          String(row.table_id),
          Number(row.event_id),
          String(row.started_at),
          cutoff,
        )
        .map((event) => ({ type: String(event.type), payload: parse(event.payload) }));
      const roster = researchRoster(contexts, identityEvents);
      const opponents = [...roster.opponentSeats.keys()];
      const result = parse(row.payload);
      if (
        typeof result.ts === 'string' &&
        (!Number.isFinite(Date.parse(result.ts)) || result.ts > cutoff)
      )
        continue;
      hands.push({
        id: String(row.id),
        profit: Number(row.profit),
        eventId: Number(row.event_id),
        availableAt:
          String(row.received_at) > String(row.ended_at)
            ? String(row.received_at)
            : String(row.ended_at),
        decisions,
        result,
        board: cards(JSON.parse(String(row.board))),
        bigBlind: Number(row.big_blind),
        opponents,
        ...roster,
      });
    }
    if (!hands.length) return [];
    const keys = [...new Set(hands.flatMap((h) => h.opponents))].slice(0, 6);
    return [
      this.build(hands, 'leak_review', 'global', cutoff),
      ...keys.map((key) =>
        this.build(
          hands.filter((h) => h.opponents.includes(key)),
          'opponent_brief',
          key,
          cutoff,
        ),
      ),
    ];
  }
  private build(
    hands: Hand[],
    taskType: ResearchBatchV2['taskType'],
    scopeKey: string,
    cutoff: string,
  ): ResearchBatchV2 {
    const sampled = stratified(hands);
    const examples: EvidenceExample[] = [];
    for (const hand of sampled) {
      const decision = hand.decisions.at(-1);
      if (decision && number(decision.visible_event_id)) {
        const context = parse(decision.context);
        const candidates = array(JSON.parse(String(decision.candidates))).map(object);
        const selected = candidates.find((c) => c.id === decision.selected);
        const request = object(parse(decision.proposal).request);
        const actualState = object(request.state);
        const summary = {
          actualInput: actualInputFacts(request, decision.selected),
          requestEvidence: {
            storedRequestHash: Object.keys(request).length
              ? createHash('sha256').update(JSON.stringify(request)).digest('hex')
              : null,
            harnessProvided: Object.keys(object(actualState.harness)).length > 0,
            opponentMemoryItems: array(actualState.opponentMemory).length,
            strategyReferenceCount: array(object(actualState.knowledge).references).length,
            adviceItems: array(actualState.approvedAdvice).length,
            sameHandSessionProvided: Object.keys(object(actualState.session)).length > 0,
          },
          observed: visible(context, hand.excludedSeats),
          offered: candidates
            .slice(0, 12)
            .map((c) => ({ action: known(c.action, ACTIONS), amount: number(c.amount) })),
          chosen: selected
            ? { action: known(selected.action, ACTIONS), amount: number(selected.amount) }
            : null,
          accepted: decision.status === 'accepted',
          actionSource: known(decision.source, ['jev', 'baseline', 'fallback', 'unavailable']),
        };
        const observed = summary.observed;
        while (
          JSON.stringify(summary).length > 3900 &&
          Array.isArray(observed.history) &&
          observed.history.length
        )
          observed.history.shift();
        while (
          JSON.stringify(summary).length > 3900 &&
          Array.isArray(observed.session) &&
          observed.session.length
        )
          observed.session.shift();
        while (
          JSON.stringify(summary).length > 3900 &&
          summary.actualInput &&
          summary.actualInput.criteria.length > 1
        ) {
          summary.actualInput.criteria.pop();
          summary.actualInput.criteriaOmitted++;
        }
        examples.push({
          id: `decision-${decision.id}`,
          handId: hand.id,
          eventId: Number(decision.visible_event_id),
          availableAt: String(decision.created_at),
          phase: 'decision_visible',
          ...(taskType === 'opponent_brief' ? { opponentKey: scopeKey } : {}),
          summary: JSON.stringify(summary),
        });
      }
      examples.push({
        id: `settlement-${hand.eventId}`,
        handId: hand.id,
        eventId: hand.eventId,
        availableAt: hand.availableAt,
        phase: 'post_settlement',
        ...(taskType === 'opponent_brief' ? { opponentKey: scopeKey } : {}),
        summary: JSON.stringify(postSettlement(hand)),
      });
    }
    const watermark = Math.max(...hands.map((h) => h.eventId));
    const availableAt = hands.reduce(
      (a, h) => (h.availableAt > a ? h.availableAt : a),
      hands[0]!.availableAt,
    );
    const common = { handIds: hands.map((h) => h.id), throughEventId: watermark, availableAt };
    const metrics: EvidenceMetric[] = ['loss', 'win', 'zero'].map((kind, i) => ({
      id: `outcome-${kind}`,
      name: `${kind}_hands_in_window`,
      numerator: hands.filter((h) =>
        i === 0 ? h.profit < 0 : i === 1 ? h.profit > 0 : h.profit === 0,
      ).length,
      denominator: hands.length,
      ...common,
    }));
    if (taskType === 'opponent_brief') {
      metrics.length = 0;
      const observations = hands.flatMap((hand) => {
        const seat = hand.opponentSeats.get(scopeKey);
        return seat !== undefined
          ? array(hand.result.actions)
              .map(object)
              .filter((a) => a.seat === seat && known(a.action, ACTIONS))
          : [];
      });
      for (const street of STREETS) {
        const seen = observations.filter((a) => a.street === street);
        if (seen.length)
          metrics.push({
            id: `${scopeKey}-${street}-raises`,
            name: `${street}_raises_among_observed_actions`,
            numerator: seen.filter((a) => a.action === 'raise').length,
            denominator: seen.length,
            opponentKey: scopeKey,
            ...common,
          });
      }
    }
    const base = baselineSnapshot();
    const batch: ResearchBatchV2 = {
      batchId: randomUUID(),
      taskType,
      scopeKey,
      basePolicyVersion: base.version,
      researchPromptVersion: 'research-prompt-v2',
      inputSchemaVersion: 'research-batch-v2',
      rulesetVersion: base.rulesetVersion,
      contextSchemaVersion: base.contextSchemaVersion,
      sourceSnapshotHash: '0'.repeat(64),
      evidenceEventWatermark: watermark,
      cutoff,
      eligibleHandIds: hands.map((h) => h.id),
      metrics,
      examples,
      sampleDefinition: `Newest at most 100 verified completed live hands, task scope filtered; ${sampled.length} examples round-robin from loss/win/zero strata, chronological within stratum, ordinary outcomes included. Count metrics use full eligible window; examples are not frequency estimates.`,
      missingness: [
        'Unknown private opponent cards are absent; public showdown samples are selected and cannot estimate bluff prevalence.',
        'Only final recorded decision per sampled hand is expanded; earlier decisions contribute a bounded same-hand visible session.',
        'Historical prompt prose and arbitrary names are deliberately excluded; missing inputs cannot be inferred from these examples.',
        'Changed, duplicated or waiting-only seat identities are excluded from opponent attribution. Excluded seats remain marked in visible and settled examples.',
        'Hands with events beyond the requested cutoff are excluded: current mutable hand aggregates cannot prove their earlier values.',
      ],
      disclosureMode: 'existing-public-live-hero-cards-and-decisions',
    };
    // Leave room for the fixed schemas/instructions in the existing 48k transport contract.
    if (JSON.stringify(batch).length > 32000)
      batch.missingness.push(
        'Additional sampled examples omitted to bound the serialized research request.',
      );
    while (JSON.stringify(batch).length > 32000 && batch.examples.length > 2)
      batch.examples.splice(-2);
    if (JSON.stringify(batch).length > 40000) throw new Error('research_evidence_too_large');
    const normalized = ResearchBatchSchema.parse(batch);
    normalized.sourceSnapshotHash = researchBatchHash(normalized);
    return normalized;
  }
  close(): void {
    this.raw.close();
  }
}
