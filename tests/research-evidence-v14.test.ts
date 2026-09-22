import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { EvidenceBuilder } from '../src/research/evidence.js';
import { opponentKey } from '../src/knowledge/advice-validator.js';
const clean: Array<() => void> = [];
afterEach(() =>
  clean
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture(persistent = true) {
  const dir = mkdtempSync(join(tmpdir(), 'research-evidence-14-'));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'raw.sqlite'),
    derived = join(dir, 'research.sqlite');
  const raw = openDatabase(path);
  clean.push(() => raw.close());
  raw
    .prepare(
      'INSERT INTO runs(id,mode,strategy,model,status,started_at,config) VALUES(?,?,?,?,?,?,?)',
    )
    .run('r', 'live', 'jev', 'jev', 'running', '2026-01-01T00:00:00.000Z', '{}');
  const at = (index: number, offset = 0) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, index * 10 + offset)).toISOString();
  const event = (index: number, offset: number, type: string, payload: object) =>
    raw
      .prepare(
        'INSERT INTO events(run_id,hand_id,table_id,type,received_at,payload) VALUES(?,?,?,?,?,?)',
      )
      .run(
        'r',
        `h${index}`,
        `t${Math.floor(index / 20)}`,
        type,
        at(index, offset),
        JSON.stringify({ ts: at(index, offset), ...payload }),
      );
  const decision = (
    index: number,
    offset: number,
    street = 'turn',
    amount = 0,
    status = 'accepted',
  ) => {
    const context = {
      heroSeat: 0,
      street,
      pot: 600,
      toCall: amount,
      bigBlind: 20,
      board: ['Qs', 'Jh', '2d', '3c'],
      holeCards: ['Qh', 'Jd'],
      historyIncomplete: false,
      seats: [
        { seat: 0, name: 'hero', inHand: true, stack: 1000, bet: 0 },
        { seat: 1, name: 'target', inHand: true, stack: 1000, bet: amount },
        { seat: 2, name: 'folded', inHand: true, folded: true, stack: 1000, bet: 0 },
      ],
    };
    raw
      .prepare(
        'INSERT INTO decisions(id,run_id,hand_id,street,created_at,context,candidates,proposal,source,selected,status,latency_ms,cost_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `d${index}-${offset}`,
        'r',
        `h${index}`,
        street,
        at(index, offset),
        JSON.stringify(context),
        '[{"id":"call","action":"call"}]',
        '{}',
        'jev',
        'call',
        status,
        1,
        0,
      );
  };
  const add = (index: number, name = 'target', profit = 0, salient = false) => {
    raw
      .prepare(
        'INSERT INTO hands(id,run_id,table_id,hand_number,board,hero_cards,profit,big_blind,status,started_at,ended_at,complete) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `h${index}`,
        'r',
        `t${Math.floor(index / 20)}`,
        index,
        '[]',
        '["Qh","Jd"]',
        profit,
        20,
        'completed',
        at(index),
        at(index, 9),
        1,
      );
    event(index, 0, 'table_state', {
      hero: { seat: 0 },
      seats: [
        { seat: 0, name: 'hero', in_hand: true },
        { seat: 1, name, in_hand: true },
      ],
    });
    decision(index, 1, 'turn', salient ? 633 : 0);
    if (name !== 'target') {
      const row = raw.prepare('SELECT context FROM decisions WHERE id=?').get(`d${index}-1`)!;
      const context = JSON.parse(String(row.context));
      context.seats[1].name = name;
      raw
        .prepare('UPDATE decisions SET context=? WHERE id=?')
        .run(JSON.stringify(context), `d${index}-1`);
    }
    if (salient) {
      event(index, 2, 'player_action', {
        seat: 0,
        street: 'turn',
        action: 'call',
        contribution_delta: 633,
        pot_after: 1233,
      });
      decision(index, 5, 'river', 20);
    }
    event(index, 9, 'hand_result', {
      actions: [{ seat: 1, street: 'turn', action: 'raise', amount: 40 }],
      ...(salient ? { total_pot: 1273, shown_cards: { 1: ['6s', '4s'] } } : {}),
    });
  };
  const builder = new EvidenceBuilder(path, persistent ? derived : undefined);
  clean.push(() => builder.close());
  return {
    raw,
    path,
    derived,
    builder,
    add,
    event,
    at,
    decision,
    batches: (cutoff = '2026-01-02T00:00:00.000Z') => builder.batches(cutoff),
  };
}
it('retrieves an opponent across more than 100 unrelated-table hands and incrementally discovers new hands', () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.add(i);
  f.batches();
  for (let i = 12; i < 132; i++) f.add(i, 'unrelated');
  f.add(132);
  f.raw.exec('BEGIN IMMEDIATE');
  const batches = f.batches();
  f.raw.exec('ROLLBACK');
  expect(batches[0]!.eligibleHandIds).toHaveLength(100);
  const opponent = batches.find((b) => b.scopeKey === opponentKey('target'))!;
  expect(opponent.eligibleHandIds).toHaveLength(13);
  expect(opponent.eligibleHandIds).toContain('h0');
  expect(
    f.raw.prepare("SELECT name FROM sqlite_master WHERE name='research_hand_locators'").get(),
  ).toBeUndefined();
});
it('treats index identity and timestamps only as locators, revalidating raw ambiguous and future evidence', () => {
  const f = fixture();
  f.add(0);
  f.add(1);
  f.batches();
  f.event(0, 8, 'player_joined', { seat: 1, name: 'replacement', in_hand: true });
  f.event(1, 100000, 'hand_result', { actions: [] });
  f.add(2);
  const b = f.batches().find((x) => x.scopeKey === opponentKey('target'))!;
  expect(b.eligibleHandIds).toEqual(['h2']);
  expect(f.batches().some((x) => x.scopeKey === opponentKey('replacement'))).toBe(false);
});
it('offline fallback is read-only and historical cutoffs do not inherit future indexed opponents', () => {
  const f = fixture(false);
  f.add(0);
  f.add(1, 'future-name');
  f.batches();
  const before = f.batches(f.at(1));
  expect(before[0]!.eligibleHandIds).toEqual(['h0']);
  expect(before.some((b) => b.scopeKey === opponentKey('future-name'))).toBe(false);
});
it('expands the actual large turn call instead of only the final river decision and keeps showdown separate', () => {
  const f = fixture();
  f.add(0, 'target', -700, true);
  f.add(1, 'target', 10);
  f.add(2, 'target', 0);
  const b = f.batches()[0]!;
  expect(b.triggers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'large_investment', handId: 'h0', decisionId: 'd0-1' }),
      expect.objectContaining({ kind: 'large_swing', handId: 'h0' }),
      expect.objectContaining({ kind: 'showdown', handId: 'h0' }),
    ]),
  );
  const decision = b.examples.find((e) => e.id === 'decision-d0-1')!;
  const summary = JSON.parse(decision.summary);
  expect(summary.observed).toMatchObject({
    street: 'turn',
    toCall: 633,
    activePlayers: 2,
    dealtOrSeatedPlayers: 3,
  });
  expect(decision.summary).not.toContain('6s');
  expect(b.examples.find((e) => e.id === 'decision-d0-5')).toBeUndefined();
  expect(
    b.examples.find((e) => e.handId === 'h0' && e.phase === 'post_settlement')!.summary,
  ).toContain('6s');
  expect(
    b.examples
      .filter((e) => e.phase === 'post_settlement')
      .map((e) => Math.sign(JSON.parse(e.summary).profitChips))
      .sort(),
  ).toEqual([-1, 0, 1]);
  expect(f.batches()[0]!.triggers).toEqual(b.triggers);
});
it('never triggers a large investment from an unexecuted candidate, and rejects future receipt salience', () => {
  const f = fixture();
  f.add(0);
  f.decision(0, 5, 'river', 800, 'proposed');
  expect(f.batches()[0]!.triggers).toEqual([]);
  f.event(0, 100000, 'player_action', {
    seat: 0,
    street: 'river',
    action: 'call',
    contribution_delta: 800,
  });
  expect(f.batches()).toEqual([]);
});

it('reuses persisted locator cursors after restart but never trusts a stale opponent mapping', () => {
  const f = fixture();
  f.add(0);
  f.add(1, 'unrelated');
  f.batches();
  const derived = new DatabaseSync(f.derived);
  clean.push(() => derived.close());
  const cursor = derived
    .prepare('SELECT event_id,decision_rowid FROM research_locator_cursor')
    .get();
  derived
    .prepare('INSERT OR REPLACE INTO research_hand_locators VALUES(?,?,?,?)')
    .run('r', 'h1', opponentKey('target'), 999999);
  const restarted = new EvidenceBuilder(f.path, f.derived);
  clean.push(() => restarted.close());
  const batch = restarted
    .batches('2026-01-02T00:00:00.000Z')
    .find((b) => b.scopeKey === opponentKey('target'))!;
  expect(batch.eligibleHandIds).toEqual(['h0']);
  expect(
    derived.prepare('SELECT event_id,decision_rowid FROM research_locator_cursor').get(),
  ).toEqual(cursor);
});
it('refuses to use the raw database as a writable derived index', () => {
  const f = fixture();
  expect(() => new EvidenceBuilder(f.path, f.path)).toThrow('research_index_must_be_separate');
  expect(
    f.raw.prepare("SELECT name FROM sqlite_master WHERE name='research_hand_locators'").get(),
  ).toBeUndefined();
});

it('late received executed actions advance evidence availability and watermark, with exact original decision linkage', () => {
  const f = fixture();
  f.add(0);
  f.decision(0, 5, 'turn', 633);
  const before = f.batches(f.at(0, 10))[0]!;
  f.raw
    .prepare(
      'INSERT INTO actions(id,run_id,decision_id,table_id,payload,status,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('actual-0', 'r', 'd0-1', 't0', '{}', 'accepted', f.at(0, 1), 1);
  const late = f.event(0, 12, 'player_action', {
    ts: f.at(0, 2),
    action_id: 'actual-0',
    seat: 0,
    street: 'turn',
    action: 'call',
    contribution_delta: 633,
    pot_after: 1233,
  });
  const after = f.batches(f.at(0, 13))[0]!;
  expect(after.evidenceEventWatermark).toBe(Number(late.lastInsertRowid));
  expect(after.evidenceEventWatermark).toBeGreaterThan(before.evidenceEventWatermark);
  expect(
    after.metrics.every(
      (metric) =>
        metric.availableAt === f.at(0, 12) &&
        metric.throughEventId === after.evidenceEventWatermark,
    ),
  ).toBe(true);
  expect(after.triggers).toEqual([
    expect.objectContaining({
      kind: 'large_investment',
      decisionId: 'd0-1',
      eventId: Number(late.lastInsertRowid),
      availableAt: f.at(0, 12),
    }),
  ]);
  expect(after.examples.some((example) => example.id === 'decision-d0-1')).toBe(true);
  expect(after.examples.some((example) => example.id === 'decision-d0-5')).toBe(false);
  // The mutable hand now has later received evidence; historical replay cannot borrow its newer aggregate.
  expect(f.batches(f.at(0, 10))).toEqual([]);
});
it('does not guess a decision when a late same-street event has multiple matching accepted calls', () => {
  const f = fixture();
  f.add(0);
  f.decision(0, 3, 'turn', 633);
  f.decision(0, 5, 'turn', 633);
  f.event(0, 12, 'player_action', {
    ts: f.at(0, 6),
    seat: 0,
    street: 'turn',
    action: 'call',
    contribution_delta: 633,
  });
  const trigger = f.batches()[0]!.triggers!.find((item) => item.kind === 'large_investment')!;
  expect(trigger).toBeDefined();
  expect(trigger.decisionId).toBeUndefined();
});

it('keeps an older large investment and swing when newer routine showdowns would dominate recency', () => {
  const f = fixture();
  f.add(0, 'target', -100, true);
  f.add(1, 'target', 800);
  for (let i = 2; i < 9; i++) {
    f.add(i, 'target', -10);
    f.raw
      .prepare(
        "UPDATE events SET payload=json_set(payload,'$.total_pot',500,'$.shown_cards',json('{\"1\":[\"As\",\"Ad\"]}')) WHERE hand_id=? AND type='hand_result'",
      )
      .run(`h${i}`);
  }
  f.add(9, 'target', 10);
  f.add(10, 'target', 0);
  const batch = f.batches()[0]!;
  expect(batch.triggers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'large_investment', handId: 'h0', decisionId: 'd0-1' }),
      expect.objectContaining({ kind: 'large_swing', handId: 'h1' }),
      expect.objectContaining({ kind: 'showdown' }),
    ]),
  );
  expect(batch.examples.some((e) => e.id === 'decision-d0-1')).toBe(true);
  const outcomes = new Set(
    batch.examples
      .filter((e) => e.phase === 'post_settlement')
      .map((e) => Math.sign(JSON.parse(e.summary).profitChips)),
  );
  expect([...outcomes].sort()).toEqual([-1, 0, 1]);
});
