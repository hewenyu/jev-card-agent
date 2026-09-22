import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { baselineSnapshot } from '../knowledge/store.js';
import { researchRoster, type ResearchRoster } from './identity.js';
import { actualInputFacts } from './input-facts.js';
import { EvidenceIndex } from './evidence-index.js';
import { RESEARCH_PROMPT_VERSION } from './prompt-version.js';
import { completedHandTriggers } from './evidence-triggers.js';
import { opponentKey, researchBatchHash } from '../knowledge/advice-validator.js';
import {
  ResearchBatchSchema,
  type EvidenceExample,
  type EvidenceMetric,
  type ResearchBatchV2,
  type ResearchTrigger,
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
  evidenceEventId: number;
  availableAt: string;
  decisions: Raw[];
  result: Raw;
  board: string[];
  bigBlind: number;
  opponents: string[];
  triggers: ResearchTrigger[];
}
/** Whitelist, never recursive redaction: credentials, names and arbitrary model prose cannot enter. */
function visible(context: Raw, excludedSeats: number[]): Raw {
  const seats = array(context.seats).map(object);
  return {
    opponentAttributionExcludedSeats: excludedSeats,
    street: known(context.street, STREETS),
    activePlayers: seats.filter((s) => s.name != null && s.inHand !== false && !s.folded).length,
    dealtOrSeatedPlayers: seats.filter((s) => s.name != null).length,
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
  for (const group of groups)
    group.sort((a, b) => Number(a.triggers.length > 0) - Number(b.triggers.length > 0));
  const selected: Hand[] = [];
  for (let i = 0; selected.length < limit && groups.some((g) => i < g.length); i++) {
    for (const group of groups) if (group[i] && selected.length < limit) selected.push(group[i]!);
  }
  return selected;
}
export class EvidenceBuilder {
  private readonly raw: DatabaseSync;
  private readonly index: EvidenceIndex;
  constructor(path: string, indexPath?: string) {
    this.raw = new DatabaseSync(path, { readOnly: true });
    this.raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
    try {
      this.index = new EvidenceIndex(this.raw, path, indexPath);
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }
  /** Materialization is bounded and runs only in the research worker or explicit offline CLI. */
  batches(cutoff = new Date().toISOString()): ResearchBatchV2[] {
    // Full sampled requests and lightweight attribution must come from one raw snapshot.
    this.raw.exec('BEGIN');
    try {
      return this.materialize(cutoff);
    } finally {
      this.raw.exec('ROLLBACK');
    }
  }
  private materialize(cutoff: string): ResearchBatchV2[] {
    this.index.sync();
    const rows = this.rows(cutoff);
    const hands = rows.flatMap((row) => this.load(row, cutoff));
    if (!hands.length) return [];
    const keys = [...new Set(hands.flatMap((h) => h.opponents))].slice(0, 6);
    const loaded = new Map(hands.map((h) => [h.id, h]));
    return [
      this.build(hands, 'leak_review', 'global', cutoff),
      ...keys.map((key) => {
        const matched: Hand[] = hands.filter((hand) => hand.opponents.includes(key));
        const seen = new Set(matched.map((hand) => hand.id));
        for (const candidate of this.index.candidates(key)) {
          if (matched.length === 100) break;
          if (seen.has(candidate.hand_id)) continue;
          const hand =
            loaded.get(candidate.hand_id) ??
            this.rows(cutoff, candidate.run_id, candidate.hand_id).flatMap((row) =>
              this.load(row, cutoff),
            )[0];
          if (hand) loaded.set(hand.id, hand);
          // Index metadata is never evidence: strict live/cutoff/roster validation above is authoritative.
          if (hand?.opponents.includes(key)) {
            matched.push(hand);
            seen.add(hand.id);
          }
          if (matched.length === 100) break;
        }
        return this.build(
          matched.sort((a, b) => b.eventId - a.eventId),
          'opponent_brief',
          key,
          cutoff,
        );
      }),
    ];
  }
  private rows(cutoff: string, runId?: string, handId?: string): Raw[] {
    return this.raw
      .prepare(
        `SELECT h.*,e.id AS event_id,e.received_at,e.payload FROM ${
          handId
            ? 'hands h JOIN runs r ON r.id=h.run_id JOIN events e ON e.run_id=h.run_id AND e.hand_id=h.id'
            : 'events e CROSS JOIN hands h ON h.id=e.hand_id AND h.run_id=e.run_id CROSS JOIN runs r ON r.id=h.run_id'
        }
      WHERE e.type='hand_result' AND e.id=(SELECT MAX(x.id) FROM events x WHERE x.run_id=h.run_id AND x.hand_id=h.id AND x.type='hand_result' AND x.received_at<=?)
      AND r.mode='live' AND h.complete=1 AND h.profit IS NOT NULL AND h.big_blind>0 AND h.ended_at<=?
      AND NOT EXISTS (SELECT 1 FROM events later WHERE later.run_id=h.run_id AND later.hand_id=h.id AND (later.received_at>? OR json_extract(later.payload,'$.ts')>?))
      AND NOT EXISTS (SELECT 1 FROM decisions later_decision WHERE later_decision.run_id=h.run_id AND later_decision.hand_id=h.id AND later_decision.created_at>?)
      ${handId ? 'AND h.run_id=? AND h.id=?' : ''}
      ORDER BY e.id DESC LIMIT 100`,
      )
      .all(cutoff, cutoff, cutoff, cutoff, cutoff, ...(handId ? [runId!, handId] : []));
  }
  private load(row: Raw, cutoff: string): Hand[] {
    const hands: Hand[] = [];
    const decisions = this.raw
      .prepare(
        `SELECT d.id,json_object('handId',json_extract(d.context,'$.handId'),'heroSeat',json_extract(d.context,'$.heroSeat'),'street',json_extract(d.context,'$.street'),'seats',json_extract(d.context,'$.seats'),'history',json_extract(d.context,'$.history'),'toCall',json_extract(d.context,'$.toCall')) AS context,d.candidates,d.selected,d.status,d.source,d.created_at,(SELECT MAX(e.id) FROM events e WHERE e.hand_id=d.hand_id AND e.run_id=d.run_id AND e.received_at<=d.created_at) AS visible_event_id FROM decisions d WHERE d.hand_id=? AND d.run_id=? AND d.created_at<=? ORDER BY d.created_at DESC,d.id DESC`,
      )
      .all(String(row.id), String(row.run_id), String(row.ended_at))
      .reverse() as Raw[];
    const contexts = decisions.map((d) => parse(d.context));
    const identityEvents = this.raw
      .prepare(
        "SELECT type,payload FROM events WHERE hand_id=? AND run_id=? AND table_id=? AND received_at>=? AND received_at<=? AND type IN ('table_state','table_joined','hand_start','player_joined','player_left') ORDER BY id",
      )
      .all(String(row.id), String(row.run_id), String(row.table_id), String(row.started_at), cutoff)
      .map((event) => ({ type: String(event.type), payload: parse(event.payload) }));
    const eventBoundary = this.raw
      .prepare(
        `SELECT MAX(id) AS event_id,MAX(received_at) AS received_at,MAX(json_extract(payload,'$.ts')) AS source_at FROM events WHERE run_id=? AND hand_id=?`,
      )
      .get(String(row.run_id), String(row.id))!;
    const roster = researchRoster(contexts, identityEvents);
    const opponents = [...roster.opponentSeats.keys()];
    const result = parse(row.payload);
    if (
      typeof result.ts === 'string' &&
      (!Number.isFinite(Date.parse(result.ts)) || result.ts > cutoff)
    )
      return [];
    hands.push({
      id: String(row.id),
      profit: Number(row.profit),
      eventId: Number(row.event_id),
      evidenceEventId: Number(eventBoundary.event_id),
      availableAt: [
        String(row.received_at),
        String(eventBoundary.received_at),
        typeof eventBoundary.source_at === 'string' ? eventBoundary.source_at : '',
        String(row.ended_at),
        typeof result.ts === 'string' ? result.ts : '',
      ]
        .sort()
        .at(-1)!,
      decisions,
      result,
      board: cards(JSON.parse(String(row.board))),
      bigBlind: Number(row.big_blind),
      opponents,
      triggers: completedHandTriggers(
        this.raw,
        {
          ...row,
          evidence_received_at: eventBoundary.received_at,
          evidence_source_at: eventBoundary.source_at,
        },
        decisions,
        result,
        cutoff,
      ),
      ...roster,
    });
    return hands;
  }
  private build(
    hands: Hand[],
    taskType: ResearchBatchV2['taskType'],
    scopeKey: string,
    cutoff: string,
  ): ResearchBatchV2 {
    // At most three salient hands plus outcome-stratified controls. Trigger metadata is
    // emitted only for examples that survive the transport bound, so every trigger is inspectable.
    const salient: Hand[] = [];
    for (const kind of ['large_investment', 'large_swing', 'showdown']) {
      if (salient.some((h) => h.triggers.some((trigger) => trigger.kind === kind))) continue;
      const hand = hands.find((h) => h.triggers.some((trigger) => trigger.kind === kind));
      if (hand) salient.push(hand);
    }
    for (const hand of hands) {
      if (salient.length === 3) break;
      if (hand.triggers.length && !salient.includes(hand)) salient.push(hand);
    }
    const sampled = [
      ...salient,
      ...stratified(
        hands.filter((h) => !salient.includes(h)),
        6 - salient.length,
      ),
    ];
    const examples: EvidenceExample[] = [];
    for (const hand of sampled) {
      const importantIds = new Set(
        hand.triggers.flatMap((t) => (t.decisionId ? [t.decisionId] : [])),
      );
      const important = hand.decisions.filter((d) => importantIds.has(String(d.id))).slice(-2);
      const selectedDecisions = important.length ? important : hand.decisions.slice(-1);
      for (const decision of selectedDecisions) {
        if (decision && number(decision.visible_event_id)) {
          const full = this.raw
            .prepare('SELECT context,proposal FROM decisions WHERE id=?')
            .get(String(decision.id))!;
          const context = parse(full.context);
          const candidates = array(JSON.parse(String(decision.candidates))).map(object);
          const selected = candidates.find((c) => c.id === decision.selected);
          const request = object(parse(full.proposal).request);
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
    const watermark = Math.max(...hands.map((h) => h.evidenceEventId));
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
      researchPromptVersion: RESEARCH_PROMPT_VERSION,
      inputSchemaVersion: 'research-batch-v2',
      rulesetVersion: base.rulesetVersion,
      contextSchemaVersion: base.contextSchemaVersion,
      sourceSnapshotHash: '0'.repeat(64),
      evidenceEventWatermark: watermark,
      cutoff,
      eligibleHandIds: hands.map((h) => h.id),
      metrics,
      examples,
      sampleDefinition: `Newest at most 100 verified completed live hands independently per scope across tables; ${sampled.length} sampled hands prioritizing category coverage of large investment, large swing and showdown (up to three salient hands) and loss/win/zero comparison strata. Count metrics use the full window; selected examples and triggers are not frequency estimates.`,
      missingness: [
        'Unknown private opponent cards are absent; public showdown samples are selected and cannot estimate bluff prevalence.',
        'Actual server-confirmed large investments prioritize their matching decision (at most two per hand); otherwise the final recorded decision is expanded. Settlement information is kept separate.',
        'Large investment events without unique archived action/decision linkage have no decisionId; do not attribute them to the final sampled decision.',
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
    while (JSON.stringify(batch).length > 30000) {
      const retained = sampled.filter((h) => batch.examples.some((e) => e.handId === h.id));
      const removable = [...retained]
        .reverse()
        .find(
          (h) =>
            h !== salient[0] &&
            h.triggers.every((trigger) =>
              retained.some(
                (other) => other !== h && other.triggers.some((t) => t.kind === trigger.kind),
              ),
            ) &&
            retained.some(
              (other) => other !== h && Math.sign(other.profit) === Math.sign(h.profit),
            ),
        );
      if (!removable) break; // Preserve the key salient hand and every available outcome stratum.
      batch.examples = batch.examples.filter((e) => e.handId !== removable.id);
    }
    batch.triggers = sampled
      .flatMap((h) => h.triggers)
      .filter(
        (trigger) =>
          batch.examples.some(
            (e) => e.handId === trigger.handId && e.phase === 'post_settlement',
          ) &&
          (!trigger.decisionId ||
            batch.examples.some((e) => e.id === `decision-${trigger.decisionId}`)),
      )
      .slice(0, 32);
    // Mandatory event categories and outcome controls cannot be dropped just to fit.
    // Compact bounded action/context lists while preserving selected facts, cards and all linked decisions.
    const compactable = batch.examples.map((example) => ({
      example,
      summary: JSON.parse(example.summary) as Raw,
    }));
    while (JSON.stringify(batch).length > 39000) {
      let changed = false;
      for (const item of compactable) {
        const observed = object(item.summary.observed);
        const input = object(item.summary.actualInput);
        const list = [
          item.summary.actions,
          observed.history,
          observed.session,
          input.criteria,
        ].find(
          (value) => Array.isArray(value) && value.length > (value === input.criteria ? 1 : 0),
        );
        if (!Array.isArray(list)) continue;
        if (list === input.criteria) {
          list.pop();
          input.criteriaOmitted = Number(input.criteriaOmitted ?? 0) + 1;
        } else list.shift();
        item.example.summary = JSON.stringify(item.summary);
        changed = true;
        if (JSON.stringify(batch).length <= 39000) break;
      }
      if (!changed) break;
    }
    if (JSON.stringify(batch).length > 40000) throw new Error('research_evidence_too_large');
    const normalized = ResearchBatchSchema.parse(batch);
    normalized.sourceSnapshotHash = researchBatchHash(normalized);
    return normalized;
  }
  close(): void {
    this.index.close();
    this.raw.close();
  }
}
