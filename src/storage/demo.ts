import { buildCandidates, buildContext, createInitialState } from '../core/index.js';
import type { PokerState, Proposal } from '../core/types.js';
import type { ServerEvent } from '../openpoker/protocol.js';
import type { Store } from './store.js';

/** Synthetic, deterministic fixture. No network calls and no implication of actual performance. */
export function seedDemo(store: Store): void {
  if (store.db.prepare("SELECT id FROM runs WHERE id='demo-jev'").get()) return;
  const names = ['RiverBot', 'Copper', 'Jev', 'NorthStar', 'Atlas', 'Pocket'];
  for (const strategy of ['baseline', 'jev'] as const) {
    const runId = `demo-${strategy}`;
    const startMs = Date.UTC(2026, 8, 1, strategy === 'jev' ? 16 : 14);
    store.beginRun({
      id: runId,
      kind: 'demo',
      strategy,
      startedAt: new Date(startMs).toISOString(),
      config: { strategy },
    });
    const profits = strategy === 'jev' ? [140, -60, 240, 80] : [-80, 60, -120, 100];
    for (let index = 0; index < profits.length; index++) {
      const handId = `${runId}-hand-${index + 1}`;
      const time = startMs + index * 180_000;
      const state: PokerState = {
        ...createInitialState(),
        tableId: `demo-table-${strategy}`,
        handId,
        heroSeat: 2,
        dealerSeat: index,
        actorSeat: 2,
        street: 'preflop',
        smallBlind: 10,
        bigBlind: 20,
        pot: 30,
        holeCards: index % 2 ? ['Qh', 'Qs'] : ['Ah', 'Kd'],
        complete: false,
        historyIncomplete: false,
        handStartStacks: { '2': 2000 },
        turnToken: 'synthetic-demo',
        seats: names.map((name, seat) => ({
          seat,
          name,
          stack: 2000,
          bet: 0,
          status: 'active',
          inHand: true,
          folded: false,
        })),
      };
      let seq = index * 20;
      const add = (type: string, extra: Record<string, unknown> = {}) => {
        const event: ServerEvent = {
          type,
          table_id: state.tableId!,
          hand_id: handId,
          table_seq: ++seq,
          ts: new Date(time + (seq % 20) * 4000).toISOString(),
          ...extra,
        };
        store.appendEvent(runId, event, event.ts!);
        store.saveHand(runId, state, event);
      };
      add('hand_start', {
        dealer_seat: index,
        blinds: { small_blind: 10, big_blind: 20 },
        seat: 2,
      });
      add('hole_cards', { cards: state.holeCards });
      add('table_state', {
        street: 'preflop',
        pot: 30,
        board: [],
        seats: state.seats,
        hero: { seat: 2, hole_cards: state.holeCards },
      });
      for (const street of ['flop', 'river'] as const) {
        state.street = street;
        state.board = street === 'flop' ? ['As', '7d', '2c'] : ['As', '7d', '2c', 'Tc', '4h'];
        state.pot = street === 'flop' ? 120 : 280;
        state.validActions = [
          { action: 'fold' },
          { action: 'call', amount: 40 },
          { action: 'raise', min: 80, max: 2000 },
        ];
        add('community_cards', { street, cards: street === 'flop' ? state.board : ['Tc', '4h'] });
        add('table_state', {
          street,
          pot: state.pot,
          board: state.board,
          seats: state.seats,
          hero: { seat: 2, hole_cards: state.holeCards, valid_actions: state.validActions },
        });
        const candidates = buildCandidates(state);
        const selected =
          candidates.find((c) => c.action === (street === 'flop' ? 'call' : 'raise')) ??
          candidates[0]!;
        const context = buildContext(state, []);
        const proposal: Proposal = {
          candidateId: selected.id,
          selected: selected.id,
          source: strategy,
          explanation: 'Synthetic demonstration decision; not a real model response.',
          latencyMs: strategy === 'jev' ? 580 + index * 43 : 1,
          model: strategy === 'jev' ? 'synthetic-jev-demo' : 'heuristic-v1',
          probabilities: Object.fromEntries(
            candidates.map((c) => [
              c.id,
              c.id === selected.id ? 0.78 : 0.22 / (candidates.length - 1),
            ]),
          ),
          confidence: 0.72,
        };
        const decisionId = `${handId}-${street}`;
        store.saveDecision({
          id: decisionId,
          runId,
          handId,
          createdAt: new Date(time + (seq % 20) * 4000).toISOString(),
          context,
          candidates,
          proposal,
          fallbackReason: null,
        });
        store.prepareAction({
          id: decisionId,
          runId,
          decisionId,
          tableId: state.tableId!,
          status: 'prepared',
          createdAt: new Date(time).toISOString(),
          deadlineAt: time + 45_000,
          payload: {
            type: 'action',
            action: selected.action,
            hand_id: handId,
            client_action_id: decisionId,
            turn_token: 'synthetic-demo',
            ...(selected.amount === undefined ? {} : { amount: selected.amount }),
          },
        });
        store.updateAction(decisionId, 'accepted');
        add('player_action', {
          seat: 2,
          name: 'Jev',
          action: selected.action,
          amount: selected.amount ?? 40,
          street,
          action_id: decisionId,
          pot: state.pot,
          stack: 1960,
        });
      }
      state.complete = true;
      const profit = profits[index]!;
      state.seats[2]!.stack = 2000 + profit;
      add('hand_result', {
        final_stacks: { '2': 2000 + profit },
        winners: profit > 0 ? [{ seat: 2, amount: profit }] : [],
        shown_cards: { '2': state.holeCards },
      });
      if (strategy === 'jev' && index === 3)
        store.db
          .prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('demo_table',?)")
          .run(JSON.stringify(state));
    }
    store.finishRun(
      runId,
      'stopped',
      new Date(startMs + 4 * 180_000).toISOString(),
      'Synthetic demonstration fixture',
    );
  }
}
