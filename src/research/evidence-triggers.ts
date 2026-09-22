import type { DatabaseSync } from 'node:sqlite';
import type { ResearchTrigger } from './contracts.js';
type Raw = Record<string, unknown>;
const object = (v: unknown): Raw =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
function parse(v: unknown): Raw {
  try {
    return object(JSON.parse(String(v)));
  } catch {
    return {};
  }
}

/** Salience describes settled evidence, never a live action instruction or an error label. */
export function completedHandTriggers(
  raw: DatabaseSync,
  row: Raw,
  decisions: Raw[],
  result: Raw,
  cutoff: string,
): ResearchTrigger[] {
  const blind = Number(row.big_blind);
  if (!(blind > 0)) return [];
  const availableAt = [
    String(row.received_at),
    String(row.ended_at),
    typeof result.ts === 'string' ? result.ts : '',
    typeof row.evidence_received_at === 'string' ? row.evidence_received_at : '',
    typeof row.evidence_source_at === 'string' ? row.evidence_source_at : '',
  ]
    .sort()
    .at(-1)!;
  if (availableAt > cutoff) return [];
  const common = { handId: String(row.id), availableAt };
  const triggers: ResearchTrigger[] = [];
  const events = raw
    .prepare(
      `SELECT id,received_at,payload FROM events WHERE run_id=? AND hand_id=? AND table_id=? AND received_at<=? AND type='player_action' ORDER BY id`,
    )
    .all(String(row.run_id), String(row.id), String(row.table_id), cutoff);
  const heroSeats = new Set(
    decisions.map((d) => finite(parse(d.context).heroSeat)).filter((s) => s !== null),
  );
  if (heroSeats.size === 1) {
    const heroSeat = [...heroSeats][0];
    for (const event of events) {
      const action = parse(event.payload),
        delta = finite(action.contribution_delta);
      if (action.seat !== heroSeat || delta === null || delta < blind * 20) continue;
      if (
        typeof action.ts === 'string' &&
        (!Number.isFinite(Date.parse(action.ts)) || action.ts > cutoff)
      )
        continue;
      // Only the server's actual extra investment qualifies, never a merely proposed candidate.
      const actionId = action.client_action_id ?? action.action_id;
      const linked =
        typeof actionId === 'string'
          ? raw
              .prepare('SELECT decision_id FROM actions WHERE id=? AND run_id=? AND table_id=?')
              .get(actionId, String(row.run_id), String(row.table_id))
          : undefined;
      const possible = decisions.filter((d) => {
        if (d.status !== 'accepted' || String(d.created_at) > String(event.received_at))
          return false;
        if (linked) return d.id === linked.decision_id;
        // Never replace an explicit but unresolvable action identity with a temporal guess.
        if (typeof actionId === 'string' && actionId) return false;
        const context = parse(d.context);
        if (action.street && context.street !== action.street) return false;
        if (typeof action.ts === 'string' && String(d.created_at) > action.ts) return false;
        const chosen = array(JSON.parse(String(d.candidates)))
          .map(object)
          .find((c) => c.id === d.selected);
        if (!chosen || chosen.action !== action.action) return false;
        const hero = array(context.seats)
          .map(object)
          .find((seat) => seat.seat === context.heroSeat);
        const stack = finite(hero?.stack),
          bet = finite(hero?.bet),
          price = finite(context.toCall),
          target = finite(chosen.amount);
        const contribution =
          chosen.action === 'all_in'
            ? stack
            : chosen.action === 'call' && price !== null && stack !== null
              ? Math.min(price, stack)
              : chosen.action === 'raise' && target !== null && bet !== null
                ? Math.max(0, target - bet)
                : null;
        return contribution === delta;
      });
      const decision = possible.length === 1 ? possible[0] : undefined;
      triggers.push({
        ...common,
        availableAt: [
          availableAt,
          String(event.received_at),
          typeof action.ts === 'string' ? action.ts : '',
        ]
          .sort()
          .at(-1)!,
        kind: 'large_investment',
        eventId: Number(event.id),
        ...(decision ? { decisionId: String(decision.id) } : {}),
      });
    }
  }
  if (Math.abs(Number(row.profit)) >= 30 * blind)
    triggers.push({ ...common, kind: 'large_swing', eventId: Number(row.event_id) });
  const shown = Object.values(object(result.shown_cards)).some(
    (value) =>
      array(value).filter((card) => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card))
        .length === 2,
  );
  const lastAction = parse(events.at(-1)?.payload);
  const pot = finite(result.total_pot) ?? finite(result.pot) ?? finite(lastAction.pot_after);
  if (shown && pot !== null && pot >= 20 * blind)
    triggers.push({ ...common, kind: 'showdown', eventId: Number(row.event_id) });
  return triggers;
}
