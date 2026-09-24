import { evaluateCards } from '../../core/poker-cards.js';

export interface PotPlayer {
  seat: number;
  committed: number;
  folded: boolean;
  cards: string[];
}
export interface SettledPot {
  amount: number;
  eligible: number[];
  winners: number[];
  kind: 'contested' | 'uncalled';
}
export interface PokerSettlement {
  payouts: number[];
  pots: SettledPot[];
}

/** Layer contributions first, then award only to players eligible for that layer. */
export function settlePots(players: PotPlayer[], board: string[], dealer: number): PokerSettlement {
  if (
    players.length !== 6 ||
    new Set(players.map((p) => p.seat)).size !== 6 ||
    players.some(
      (p) =>
        !Number.isSafeInteger(p.seat) ||
        p.seat < 0 ||
        p.seat > 5 ||
        !Number.isSafeInteger(p.committed) ||
        p.committed < 0,
    ) ||
    !Number.isSafeInteger(dealer) ||
    dealer < 0 ||
    dealer > 5
  ) {
    throw new Error('Invalid six-max settlement');
  }
  const live = players.filter((p) => !p.folded);
  if (!live.length) throw new Error('No player eligible for settlement');
  const payouts = Array<number>(6).fill(0);
  const pots: SettledPot[] = [];
  const levels = [...new Set(players.map((p) => p.committed).filter((n) => n > 0))].sort(
    (a, b) => a - b,
  );
  let previous = 0;
  for (const level of levels) {
    const contributors = players.filter((p) => p.committed >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    const eligible = contributors.filter((p) => !p.folded);
    let winners: number[];
    const kind = contributors.length === 1 ? 'uncalled' : 'contested';
    if (kind === 'uncalled') winners = [contributors[0]!.seat];
    else if (live.length === 1) winners = [live[0]!.seat];
    else if (eligible.length === 1) winners = [eligible[0]!.seat];
    else {
      if (!eligible.length || board.length !== 5) throw new Error('Incomplete showdown');
      const ranks = eligible.map((p) => {
        const value = evaluateCards([...p.cards, ...board]);
        if (!value) throw new Error('Invalid showdown cards');
        return { seat: p.seat, score: value.score };
      });
      const best = Math.max(...ranks.map((p) => p.score));
      winners = ranks.filter((p) => p.score === best).map((p) => p.seat);
    }
    winners.sort((a, b) => ((a - dealer + 5) % 6) - ((b - dealer + 5) % 6));
    for (let i = 0; i < winners.length; i++) {
      const seat = winners[i]!;
      payouts[seat] =
        payouts[seat]! + Math.floor(amount / winners.length) + Number(i < amount % winners.length);
    }
    pots.push({ amount, eligible: eligible.map((p) => p.seat), winners, kind });
  }
  if (payouts.reduce((a, b) => a + b, 0) !== players.reduce((sum, p) => sum + p.committed, 0)) {
    throw new Error('Settlement violated chip conservation');
  }
  return { payouts, pots };
}
