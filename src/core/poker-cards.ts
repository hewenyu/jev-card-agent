const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const NAMES = [
  'high_card',
  'one_pair',
  'two_pair',
  'three_of_a_kind',
  'straight',
  'flush',
  'full_house',
  'four_of_a_kind',
  'straight_flush',
] as const;
const SCALE = 15 ** 5;

export interface HandValue {
  category: number;
  name: (typeof NAMES)[number];
  /** Lexicographic tie breakers, rank 14 = ace; wheel straight high = 5. */
  ranks: number[];
  /** Larger is stronger. Suits never break a tie. */
  score: number;
}

function decode(cards: readonly string[]): number[] | null {
  const ids: number[] = [];
  for (const card of cards) {
    if (!/^[2-9TJQKA][cdhs]$/.test(card)) return null;
    ids.push(RANKS.indexOf(card[0]!) * 4 + SUITS.indexOf(card[1]!));
  }
  return new Set(ids).size === ids.length ? ids : null;
}
function encode(id: number): string {
  return RANKS[Math.floor(id / 4)]! + SUITS[id % 4]!;
}
function straightHigh(mask: number): number {
  for (let high = 14; high >= 6; high--) if (((mask >> (high - 4)) & 31) === 31) return high;
  return (mask & ((1 << 14) | 60)) === ((1 << 14) | 60) ? 5 : 0;
}
function pack(category: number, ranks: number[]): number {
  let result = category;
  for (let i = 0; i < 5; i++) result = result * 15 + (ranks[i] ?? 0);
  return result;
}
function topRanks(mask: number, limit: number): number[] {
  const result: number[] = [];
  for (let rank = 14; rank >= 2 && result.length < limit; rank--)
    if (mask & (1 << rank)) result.push(rank);
  return result;
}

/** Direct best-five ranking for 5–7 cards; no enumeration in the simulation hot path. */
function scoreCards(ids: readonly number[]): number {
  const counts = new Uint8Array(15);
  const suitCounts = new Uint8Array(4);
  const suitMasks = new Uint16Array(4);
  let mask = 0;
  for (const id of ids) {
    const rank = Math.floor(id / 4) + 2;
    const suit = id % 4;
    counts[rank] = counts[rank]! + 1;
    suitCounts[suit] = suitCounts[suit]! + 1;
    suitMasks[suit] = suitMasks[suit]! | (1 << rank);
    mask |= 1 << rank;
  }
  const flushSuit = suitCounts.findIndex((count) => count >= 5);
  if (flushSuit >= 0) {
    const high = straightHigh(suitMasks[flushSuit]!);
    if (high) return pack(8, [high]);
  }
  const pairs: number[] = [];
  const trips: number[] = [];
  let quads = 0;
  for (let rank = 14; rank >= 2; rank--) {
    if (counts[rank] === 4) quads = rank;
    if (counts[rank] === 3) trips.push(rank);
    if (counts[rank]! >= 2) pairs.push(rank);
  }
  if (quads) return pack(7, [quads, ...topRanks(mask & ~(1 << quads), 1)]);
  if (trips.length && pairs.some((rank) => rank !== trips[0]))
    return pack(6, [trips[0]!, pairs.find((rank) => rank !== trips[0])!]);
  if (flushSuit >= 0) return pack(5, topRanks(suitMasks[flushSuit]!, 5));
  const straight = straightHigh(mask);
  if (straight) return pack(4, [straight]);
  if (trips.length) return pack(3, [trips[0]!, ...topRanks(mask & ~(1 << trips[0]!), 2)]);
  if (pairs.length >= 2)
    return pack(2, [
      pairs[0]!,
      pairs[1]!,
      ...topRanks(mask & ~(1 << pairs[0]!) & ~(1 << pairs[1]!), 1),
    ]);
  if (pairs.length) return pack(1, [pairs[0]!, ...topRanks(mask & ~(1 << pairs[0]!), 3)]);
  return pack(0, topRanks(mask, 5));
}
function describe(score: number): HandValue {
  const category = Math.floor(score / SCALE);
  let remainder = score % SCALE;
  const ranks: number[] = [];
  for (let place = 4; place >= 0; place--) {
    const rank = Math.floor(remainder / 15 ** place);
    if (rank) ranks.push(rank);
    remainder %= 15 ** place;
  }
  return { category, name: NAMES[category]!, ranks, score };
}
export function evaluateCards(cards: readonly string[]): HandValue | null {
  if (cards.length < 5 || cards.length > 7) return null;
  const ids = decode(cards);
  return ids ? describe(scoreCards(ids)) : null;
}

export interface PokerCardFacts {
  hole: { ranks: number[]; pair: boolean; suited: boolean };
  madeHand: HandValue | null;
  bestFive: { minimumHoleCards: number; maximumHoleCards: number; playsBoard: boolean } | null;
  relativeStrength: {
    highestBoardRank: number | null;
    /** Hole-card ranks appearing on the board; does not itself imply a strong hand. */
    pairedHoleRanks: number[];
    pocketPairBelowBoardHigh: boolean;
    overpair: boolean;
    topPair: boolean;
    set: boolean;
    tripsUsingOneHoleCard: boolean;
    twoPairUsingBothHoleRanks: boolean;
    boardPairPlusPocketPair: boolean;
    boardPairOnly: boolean;
    boardTwoPairOnly: boolean;
    boardTripsOnly: boolean;
    qualification: string;
  };
  board: {
    rankCounts: Record<string, number>;
    maximumSameSuit: number;
    paired: boolean;
    trips: boolean;
    /** Maximum distinct board ranks in any five-rank straight window, including A2345. */
    ranksInStraightWindow: number;
  };
  draws: {
    /** One-card completions only; not clean winning outs or implied odds. */
    straightCompletionCards: string[];
    flushCompletionCards: string[];
    cardsToCome: number;
    caveat: string;
  };
}

function relativeStrength(
  holeRanks: number[],
  rankCounts: Record<string, number>,
  made: HandValue | null,
): PokerCardFacts['relativeStrength'] {
  const boardRanks = Object.keys(rankCounts).map(Number);
  const highestBoardRank = boardRanks.length ? Math.max(...boardRanks) : null;
  const pocketPair = holeRanks[0] === holeRanks[1];
  const pairedHoleRanks = [...new Set(holeRanks)].filter((rank) => rankCounts[rank]);
  const pairRanks = made?.category === 2 ? made.ranks.slice(0, 2) : [];
  const boardPairPlusPocketPair =
    pocketPair &&
    pairRanks.includes(holeRanks[0]!) &&
    !rankCounts[holeRanks[0]!] &&
    pairRanks.some((rank) => rankCounts[rank] === 2);
  return {
    highestBoardRank,
    pairedHoleRanks,
    pocketPairBelowBoardHigh:
      pocketPair && highestBoardRank !== null && holeRanks[0]! < highestBoardRank,
    overpair:
      made?.category === 1 &&
      pocketPair &&
      highestBoardRank !== null &&
      holeRanks[0]! > highestBoardRank,
    topPair:
      made?.category === 1 &&
      !pocketPair &&
      made.ranks[0] === highestBoardRank &&
      pairedHoleRanks.includes(highestBoardRank!),
    set: made?.category === 3 && pocketPair && rankCounts[holeRanks[0]!] === 1,
    tripsUsingOneHoleCard:
      made?.category === 3 &&
      !pocketPair &&
      rankCounts[made.ranks[0]!] === 2 &&
      holeRanks.includes(made.ranks[0]!),
    twoPairUsingBothHoleRanks:
      !pocketPair &&
      pairRanks.length === 2 &&
      pairRanks.every((rank) => holeRanks.includes(rank) && rankCounts[rank] === 1),
    boardPairPlusPocketPair,
    boardPairOnly: made?.category === 1 && rankCounts[made.ranks[0]!] === 2,
    boardTwoPairOnly: pairRanks.length === 2 && pairRanks.every((rank) => rankCounts[rank] === 2),
    boardTripsOnly: made?.category === 3 && rankCounts[made.ranks[0]!] === 3,
    qualification: boardPairPlusPocketPair
      ? 'Two-pair category combines a public board pair with hero pocket pair. It is not two private value pairs; opponents share the board pair and can beat the pocket pair with a higher pair, trips or better.'
      : 'Structural card facts, not a strength percentile or a continuing-range recommendation. Board-only pairs/trips are shared; kickers, board texture and the betting range matter.',
  };
}

function contribution(ids: number[], score: number): NonNullable<PokerCardFacts['bestFive']> {
  let minimumHoleCards = 2;
  let maximumHoleCards = 0;
  const chosen: number[] = [];
  const visit = (start: number, holes: number) => {
    if (chosen.length === 5) {
      if (scoreCards(chosen) === score) {
        minimumHoleCards = Math.min(minimumHoleCards, holes);
        maximumHoleCards = Math.max(maximumHoleCards, holes);
      }
      return;
    }
    for (let i = start; i <= ids.length - (5 - chosen.length); i++) {
      chosen.push(ids[i]!);
      visit(i + 1, holes + Number(i < 2));
      chosen.pop();
    }
  };
  visit(0, 0);
  return { minimumHoleCards, maximumHoleCards, playsBoard: minimumHoleCards === 0 };
}

export function analyzePokerCards(
  holeCards: readonly string[],
  board: readonly string[],
): PokerCardFacts | null {
  if (holeCards.length !== 2 || ![0, 3, 4, 5].includes(board.length)) return null;
  const ids = decode([...holeCards, ...board]);
  if (!ids) return null;
  const holeRanks = ids
    .slice(0, 2)
    .map((id) => Math.floor(id / 4) + 2)
    .sort((a, b) => b - a);
  const boardIds = ids.slice(2);
  const rankCounts: Record<string, number> = {};
  const suits = [0, 0, 0, 0];
  let boardMask = 0;
  for (const id of boardIds) {
    const rank = Math.floor(id / 4) + 2;
    rankCounts[String(rank)] = (rankCounts[String(rank)] ?? 0) + 1;
    suits[id % 4] = suits[id % 4]! + 1;
    boardMask |= 1 << rank;
  }
  let ranksInStraightWindow = 0;
  for (let high = 5; high <= 14; high++) {
    let count = 0;
    for (let rank = high - 4; rank <= high; rank++)
      if (boardMask & (1 << (rank === 1 ? 14 : rank))) count++;
    ranksInStraightWindow = Math.max(ranksInStraightWindow, count);
  }
  const madeHand = ids.length >= 5 ? describe(scoreCards(ids)) : null;
  const straightCompletionCards: string[] = [];
  const flushCompletionCards: string[] = [];
  if (board.length === 3 || board.length === 4) {
    const visible = new Set(ids);
    for (let id = 0; id < 52; id++) {
      if (visible.has(id)) continue;
      const next = scoreCards([...ids, id]);
      // A completion exclusively on the river board gives no hero-specific draw.
      if (board.length === 4 && scoreCards([...boardIds, id]) === next) continue;
      const category = Math.floor(next / SCALE);
      if (madeHand!.category < 4 && (category === 4 || category === 8))
        straightCompletionCards.push(encode(id));
      if (madeHand!.category < 5 && (category === 5 || category === 8))
        flushCompletionCards.push(encode(id));
    }
  }
  return {
    hole: {
      ranks: holeRanks,
      pair: holeRanks[0] === holeRanks[1],
      suited: ids[0]! % 4 === ids[1]! % 4,
    },
    madeHand,
    bestFive: madeHand ? contribution(ids, madeHand.score) : null,
    relativeStrength: relativeStrength(holeRanks, rankCounts, madeHand),
    board: {
      rankCounts,
      maximumSameSuit: Math.max(...suits),
      paired: Object.values(rankCounts).some((count) => count >= 2),
      trips: Object.values(rankCounts).some((count) => count >= 3),
      ranksInStraightWindow,
    },
    draws: {
      straightCompletionCards,
      flushCompletionCards,
      cardsToCome: 5 - board.length,
      caveat:
        'One-card straight/flush completions involving hero cards; may lose to stronger hands. Not clean winning outs. Backdoor draws are not enumerated.',
    },
  };
}

export const DEFAULT_EQUITY_SAMPLES = 1200;
export interface UniformEquity {
  method: 'deterministic_monte_carlo';
  rangeAssumption: 'uniform_random_legal_hole_cards';
  opponents: number;
  samples: number;
  seed: number;
  winProbability: number;
  tieProbability: number;
  /** Expected fraction of one equally eligible pot, including split pots. */
  equity: number;
  standardError: number | null;
  caveat: string;
}
function seedFor(value: string): number {
  let seed = 2166136261;
  for (let i = 0; i < value.length; i++) seed = Math.imul(seed ^ value.charCodeAt(i), 16777619);
  return seed >>> 0;
}
function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/** Samples without replacement from unseen cards. Never reads histories or future cards. */
export function estimateUniformEquity(
  holeCards: readonly string[],
  board: readonly string[],
  opponents: number,
  options: { samples?: number; seed?: number } = {},
): UniformEquity | null {
  const samples = options.samples ?? DEFAULT_EQUITY_SAMPLES;
  if (
    holeCards.length !== 2 ||
    ![0, 3, 4, 5].includes(board.length) ||
    !Number.isInteger(opponents) ||
    opponents < 1 ||
    opponents > 5 ||
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 10000 ||
    (options.seed !== undefined && !Number.isSafeInteger(options.seed))
  )
    return null;
  const ids = decode([...holeCards, ...board]);
  if (!ids) return null;
  const seed = (options.seed ?? seedFor(JSON.stringify([holeCards, board, opponents]))) >>> 0;
  const random = randomGenerator(seed);
  const seen = new Set(ids);
  const deck = Array.from({ length: 52 }, (_, index) => index).filter((id) => !seen.has(id));
  let wins = 0;
  let ties = 0;
  let shareSum = 0;
  let shareSquaredSum = 0;
  const knownBoard = ids.slice(2);
  const riverHeroScore = board.length === 5 ? scoreCards(ids) : null;
  for (let sample = 0; sample < samples; sample++) {
    const unseen = deck.slice();
    let cursor = 0;
    const draw = () => {
      const index = cursor + Math.floor(random() * (unseen.length - cursor));
      const drawn = unseen[index]!;
      unseen[index] = unseen[cursor]!;
      unseen[cursor++] = drawn;
      return drawn;
    };
    const completedBoard = [...knownBoard];
    while (completedBoard.length < 5) completedBoard.push(draw());
    const heroScore = riverHeroScore ?? scoreCards([ids[0]!, ids[1]!, ...completedBoard]);
    let tied = 0;
    let lost = false;
    for (let opponent = 0; opponent < opponents; opponent++) {
      const score = scoreCards([draw(), draw(), ...completedBoard]);
      if (score > heroScore) {
        lost = true;
        break;
      }
      if (score === heroScore) tied++;
    }
    if (lost) continue;
    if (tied) ties++;
    else wins++;
    const share = 1 / (tied + 1);
    shareSum += share;
    shareSquaredSum += share * share;
  }
  const equity = shareSum / samples;
  return {
    method: 'deterministic_monte_carlo',
    rangeAssumption: 'uniform_random_legal_hole_cards',
    opponents,
    samples,
    seed,
    winProbability: wins / samples,
    tieProbability: ties / samples,
    equity,
    standardError:
      samples > 1
        ? Math.sqrt(
            Math.max(0, shareSquaredSum - samples * equity * equity) / (samples - 1) / samples,
          )
        : null,
    caveat:
      'Uniform random ranges, all opponents reaching showdown, one equally eligible pot. Ignores betting ranges, folds, future costs and side-pot eligibility. Not action EV or a calibrated win probability against these opponents.',
  };
}
