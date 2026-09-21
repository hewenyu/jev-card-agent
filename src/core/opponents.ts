import type { OpponentStats, PokerState } from './types.js';

export interface OpponentCheckpoint {
  version: 1;
  stats: OpponentStats[];
  recent: Array<{
    hand: string;
    entries: Array<{
      name: string;
      preflop: boolean;
      vpip: boolean;
      pfr: boolean;
      events: string[];
    }>;
  }>;
}
type Observation = { preflop: boolean; vpip: boolean; pfr: boolean; events: Set<string> };
/** Tracks observable opportunities only. Replayed histories are idempotent by hand/action identity. */
export class OpponentTracker {
  private readonly stats = new Map<string, OpponentStats>();
  private readonly recent = new Map<string, Map<string, Observation>>();

  constructor(checkpoint?: OpponentCheckpoint) {
    if (!checkpoint) return;
    if (checkpoint.version !== 1) throw new Error('Unsupported opponent checkpoint version');
    for (const value of checkpoint.stats) this.stats.set(value.name, structuredClone(value));
    for (const hand of checkpoint.recent.slice(-1000)) {
      this.recent.set(
        hand.hand,
        new Map(
          hand.entries.map((e) => [
            e.name,
            { preflop: e.preflop, vpip: e.vpip, pfr: e.pfr, events: new Set(e.events) },
          ]),
        ),
      );
    }
  }

  exportState(): OpponentCheckpoint {
    return {
      version: 1,
      stats: this.snapshot(),
      recent: [...this.recent].map(([hand, entries]) => ({
        hand,
        entries: [...entries].map(([name, value]) => ({
          name,
          preflop: value.preflop,
          vpip: value.vpip,
          pfr: value.pfr,
          events: [...value.events],
        })),
      })),
    };
  }

  observe(state: PokerState): void {
    if (!state.handId) return;
    const hand = JSON.stringify([state.tableId, state.handId]);
    let observations = this.recent.get(hand);
    if (!observations) {
      observations = new Map();
      this.recent.set(hand, observations);
      if (this.recent.size > 1000) {
        const oldest = this.recent.keys().next().value;
        if (oldest !== undefined) this.recent.delete(oldest);
      }
    }
    for (const entry of state.history) {
      if (!entry.name || entry.seat === state.heroSeat) continue;
      const eventKey = String(entry.actionId ?? entry.tableSeq ?? JSON.stringify(entry));
      const observation = observations.get(entry.name) ?? {
        preflop: false,
        vpip: false,
        pfr: false,
        events: new Set<string>(),
      };
      if (observation.events.has(eventKey)) continue;
      observation.events.add(eventKey);
      observations.set(entry.name, observation);
      const value = this.stats.get(entry.name) ?? {
        name: entry.name,
        hands: 0,
        vpip: 0,
        pfr: 0,
        facedBet: 0,
        foldedToBet: 0,
        lastTableSeq: -1,
      };
      // VPIP/PFR denominator is hands with an observed preflop decision, not unseen dealt hands.
      if (entry.street === 'preflop') {
        if (!observation.preflop) {
          value.hands++;
          observation.preflop = true;
        }
        if (['call', 'raise', 'all_in'].includes(entry.action) && !observation.vpip) {
          value.vpip++;
          observation.vpip = true;
        }
        const isRaise =
          entry.action === 'raise' ||
          (entry.action === 'all_in' &&
            entry.toCallBefore !== null &&
            (entry.amount ?? 0) > entry.toCallBefore);
        if (isRaise && !observation.pfr) {
          value.pfr++;
          observation.pfr = true;
        }
      }
      if (entry.toCallBefore !== null && entry.toCallBefore > 0) {
        value.facedBet++;
        if (entry.action === 'fold') value.foldedToBet++;
      }
      value.lastTableSeq = Math.max(value.lastTableSeq, entry.tableSeq ?? -1);
      this.stats.set(entry.name, value);
    }
  }
  snapshot(): OpponentStats[] {
    return structuredClone([...this.stats.values()]);
  }
}
