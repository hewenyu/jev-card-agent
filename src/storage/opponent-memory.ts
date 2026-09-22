import type { DatabaseSync } from 'node:sqlite';
import type { Action, PokerState } from '../core/types.js';

import type {
  BettingStreet,
  MemoryAction,
  MemoryEncounter,
  MemoryStreetStats,
  OpponentMemory,
} from '../core/opponent-memory.js';
type Raw = Record<string, unknown>;
const STREETS: BettingStreet[] = ['preflop', 'flop', 'turn', 'river'];
const ACTIONS: Action[] = ['fold', 'check', 'call', 'raise', 'all_in'];
const VERSION = 'completed-opponent-encounters-v1';
const LIMIT = 200;

interface EventRow {
  id: number;
  run_id: string;
  hand_id: string;
  table_id: string;
  received_at: string;
  payload: string;
  type: string;
}
const raw = (value: unknown): Raw =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const cards = (value: unknown): string[] =>
  array(value).filter(
    (card): card is string => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card),
  );
function parse(value: string): Raw {
  try {
    return raw(JSON.parse(value));
  } catch {
    return {};
  }
}

export function initializeOpponentMemory(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opponent_encounters (
      table_id TEXT NOT NULL, hand_id TEXT NOT NULL, name TEXT NOT NULL,
      completed_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      result_event_id INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(table_id, hand_id, name)
    );
    CREATE INDEX IF NOT EXISTS opponent_encounters_lookup
      ON opponent_encounters(name, completed_ms DESC, received_ms);
    CREATE INDEX IF NOT EXISTS events_type_id ON events(type, id);
  `);
}

function materialize(db: DatabaseSync, result: EventRow): void {
  const end = parse(result.payload);
  const completedAt = typeof end.ts === 'string' ? end.ts : '';
  const completed = Date.parse(completedAt);
  const received = Date.parse(result.received_at);
  if (!Number.isFinite(completed) || !Number.isFinite(received)) return;
  const rows = db
    .prepare(
      `SELECT id,type,payload,received_at FROM events
      WHERE hand_id=? AND table_id=? AND id<=? ORDER BY id`,
    )
    .all(result.hand_id, result.table_id, result.id);
  const identities = new Map<number, Set<string>>();
  const heroSeats = new Set<number>();
  const playerActions: Raw[] = [];
  const seenActions = new Set<string>();
  let board: string[] = [];
  for (const row of rows) {
    const evidenceReceived = Date.parse(String(row.received_at));
    if (!Number.isFinite(evidenceReceived) || evidenceReceived > received) continue;
    const event = parse(String(row.payload));
    const evidenceTime = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    if (Number.isFinite(evidenceTime) && evidenceTime > completed) continue;
    if (row.type === 'table_state') {
      const visible = cards(event.board);
      if (visible.length >= board.length) board = visible;
      const heroSeat = finite(raw(event.hero).seat);
      if (heroSeat !== null) heroSeats.add(heroSeat);
      for (const value of array(event.seats)) {
        const seat = raw(value);
        const index = finite(seat.seat);
        if (index === null || typeof seat.name !== 'string' || !seat.name) continue;
        const names = identities.get(index) ?? new Set<string>();
        names.add(seat.name);
        identities.set(index, names);
      }
    }
    if (row.type === 'player_action') {
      const key = String(event.table_seq ?? event.action_id ?? row.id);
      if (!seenActions.has(key)) playerActions.push(event);
      seenActions.add(key);
    }
  }
  const identity = (seat: number): string | null => {
    const names = identities.get(seat);
    return names?.size === 1 ? [...names][0]! : null;
  };
  // Result actions preserve the completed street, unlike trailing streets in some live events.
  // Attach price/size metadata only if the complete event sequence aligns. A partial replay
  // must not attach a later repeated raise's price to an earlier missing raise.
  const resultActions = array(end.actions)
    .map(raw)
    .filter(
      (item) =>
        finite(item.seat) !== null &&
        STREETS.includes(item.street as BettingStreet) &&
        ACTIONS.includes(item.action as Action),
    );
  const metadataComplete =
    resultActions.length === playerActions.length &&
    resultActions.every(
      (item, index) =>
        item.seat === playerActions[index]?.seat && item.action === playerActions[index]?.action,
    );
  const line: MemoryAction[] = [];
  for (const [index, item] of resultActions.entries()) {
    const seat = item.seat as number;
    const meta: Raw = metadataComplete ? playerActions[index]! : {};
    let contribution = finite(meta.contribution_delta);
    if (item.action === 'all_in' && contribution === 0) contribution = null;
    line.push({
      seat,
      name: identity(seat),
      street: item.street as BettingStreet,
      action: item.action as Action,
      amount: finite(item.amount),
      contribution,
      potBefore: finite(meta.pot_before),
      toCallBefore: finite(meta.to_call_before),
      tableSeq: finite(meta.table_seq),
    });
  }
  if (!line.length) return;
  const heroSeat = heroSeats.size === 1 ? [...heroSeats][0]! : null;
  const heroParticipated = heroSeat !== null && line.some((action) => action.seat === heroSeat);
  const shown = raw(end.shown_cards);
  const insert = db.prepare(`INSERT OR IGNORE INTO opponent_encounters
    (table_id,hand_id,name,completed_ms,received_ms,result_event_id,payload) VALUES(?,?,?,?,?,?,?)`);
  for (const [seat] of identities) {
    const name = identity(seat);
    if (!name || seat === heroSeat || !line.some((action) => action.seat === seat)) continue;
    const revealed = cards(shown[String(seat)]);
    const encounter: MemoryEncounter = {
      handId: result.hand_id,
      tableId: result.table_id,
      completedAt,
      receivedAt: result.received_at,
      tableSeq: finite(end.table_seq),
      resultEventId: result.id,
      board,
      shownCards: revealed.length === 2 ? revealed : null,
      heroParticipated,
      line,
    };
    insert.run(
      result.table_id,
      result.hand_id,
      name,
      completed,
      received,
      result.id,
      JSON.stringify(encounter),
    );
  }
}

/** Incremental derived index. Raw events remain unchanged; duplicate replay cannot double-count hands. */
export function syncOpponentMemory(db: DatabaseSync): void {
  const cursor = Number(db.prepare('SELECT value FROM meta WHERE key=?').get(VERSION)?.value ?? 0);
  const results = db
    .prepare("SELECT * FROM events WHERE type='hand_result' AND id>? ORDER BY id")
    .all(cursor) as unknown as EventRow[];
  if (!results.length) return;
  db.exec('SAVEPOINT opponent_memory');
  try {
    for (const result of results) materialize(db, result);
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(
      VERSION,
      String(results.at(-1)!.id),
    );
    db.exec('RELEASE opponent_memory');
  } catch (error) {
    db.exec('ROLLBACK TO opponent_memory; RELEASE opponent_memory');
    throw error;
  }
}
function emptyStreet(): MemoryStreetStats {
  return {
    observedActions: 0,
    raises: 0,
    calls: 0,
    checks: 0,
    folds: 0,
    allIns: 0,
    facedBetObserved: 0,
    foldedToObservedBet: 0,
    sizedContributions: 0,
    contributionToPotSum: 0,
  };
}

function boundedEncounter(encounter: MemoryEncounter): MemoryEncounter {
  const omittedActions = Math.max(0, encounter.line.length - 32);
  return omittedActions
    ? {
        ...encounter,
        omittedActions,
        line: [...encounter.line.slice(0, 8), ...encounter.line.slice(-24)],
      }
    : encounter;
}

export function getOpponentMemory(
  db: DatabaseSync,
  state: PokerState,
  asOf: string,
): OpponentMemory[] {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) return [];
  syncOpponentMemory(db);
  const names = [
    ...new Set(
      state.seats
        .filter((seat) => seat.seat !== state.heroSeat && seat.name && seat.status !== 'empty')
        .map((seat) => seat.name!),
    ),
  ];
  const select = db.prepare(`SELECT payload FROM opponent_encounters
    WHERE name=? AND completed_ms<? AND received_ms<? AND hand_id<>?
    ORDER BY completed_ms DESC, result_event_id DESC LIMIT ?`);
  return names.flatMap((name) => {
    const found = select.all(name, cutoff, cutoff, state.handId ?? '', LIMIT + 1);
    const encounters = found
      .slice(0, LIMIT)
      .map((row) => JSON.parse(String(row.payload)) as MemoryEncounter);
    if (!encounters.length) return [];
    const streets = Object.fromEntries(STREETS.map((street) => [street, emptyStreet()])) as Record<
      BettingStreet,
      MemoryStreetStats
    >;
    for (const encounter of encounters) {
      for (const action of encounter.line) {
        if (action.name !== name) continue;
        const street = streets[action.street];
        street.observedActions++;
        const field = {
          raise: 'raises',
          call: 'calls',
          check: 'checks',
          fold: 'folds',
          all_in: 'allIns',
        } as const;
        street[field[action.action]]++;
        if (action.toCallBefore !== null && action.toCallBefore > 0) {
          street.facedBetObserved++;
          if (action.action === 'fold') street.foldedToObservedBet++;
        }
        if (
          action.contribution !== null &&
          action.contribution > 0 &&
          action.potBefore !== null &&
          action.potBefore > 0
        ) {
          street.sizedContributions++;
          street.contributionToPotSum += action.contribution / action.potBefore;
        }
      }
    }
    const showdowns = encounters.filter((encounter) => encounter.shownCards !== null);
    return [
      {
        version: VERSION,
        name,
        asOf,
        sampledHands: encounters.length,
        sampleLimit: LIMIT,
        sampleCapped: found.length > LIMIT,
        firstCompletedAt: encounters.at(-1)!.completedAt,
        lastCompletedAt: encounters[0]!.completedAt,
        shownHands: showdowns.length,
        streets,
        showdowns: showdowns.slice(0, 3).map(boundedEncounter),
        recentEncountersWithHero: encounters
          .filter(
            (encounter) => encounter.heroParticipated && !showdowns.slice(0, 3).includes(encounter),
          )
          .slice(0, 3)
          .map(boundedEncounter),
        caveats: [
          'Only observed completed hands; counts are actions, not independent hands or population frequencies.',
          'Shown cards are a selected sample, not a full range or true bluff rate. Names are public identities, not verified account IDs.',
          'Facing-bet counts require explicit positive prices; missing prices and missing event metadata are excluded.',
          'Historical hero actions are observations, not recommended policy or evidence of action EV.',
        ],
      },
    ];
  });
}
