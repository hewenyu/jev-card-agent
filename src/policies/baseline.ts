import type {
  Candidate,
  DecisionContext,
  DecisionOptions,
  Policy,
  Proposal,
} from '../core/types.js';

export function chooseFallback(candidates: Candidate[]): Candidate {
  const candidate =
    candidates.find((c) => c.action === 'check') ?? candidates.find((c) => c.action === 'fold');
  if (!candidate) throw new Error('No safe legal fallback: check/fold unavailable');
  return candidate;
}
export function fallbackProposal(
  candidates: Candidate[],
  reason = 'Decision unavailable',
): Proposal {
  const candidate = chooseFallback(candidates);
  return {
    candidateId: candidate.id,
    selected: candidate.id,
    source: 'fallback',
    explanation: `${reason}; prefer legal check, otherwise fold.`,
    latencyMs: 0,
  };
}
/** Transparent heuristic, not an equity estimator or a GTO policy. */
export function chooseBaseline(context: DecisionContext, candidates: Candidate[]): Proposal {
  const ranks = context.holeCards.map((c) => '23456789TJQKA'.indexOf(c[0] ?? '') + 2);
  const [first = 0, second = 0] = ranks;
  const pair = first === second && first >= 2;
  const premium = (pair && first >= 10) || Math.min(first, second) >= 12;
  const playable = premium || pair || Math.min(first, second) >= 9;
  const boardRanks = context.board.map((c) => c[0]);
  const hit = context.holeCards.some((c) => boardRanks.includes(c[0]));
  const free = candidates.find((c) => c.action === 'check');
  const raise = candidates
    .filter((c) => c.action === 'raise')
    .sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0))[0];
  const call = candidates.find((c) => c.action === 'call');
  let selected: Candidate | undefined;
  let explanation: string;
  if (context.street === 'preflop' && premium && raise) {
    selected = raise;
    explanation = 'Heuristic: premium starting cards; choose the smallest legal raise candidate.';
  } else if (free) {
    selected = free;
    explanation = 'Heuristic: take the available free check.';
  } else if (
    call &&
    (context.street === 'preflop'
      ? playable && context.toCall <= context.bigBlind * 3
      : hit && (context.potOdds ?? 1) <= 0.25)
  ) {
    selected = call;
    explanation =
      context.street === 'preflop'
        ? 'Heuristic: playable starting cards and call cost at most three big blinds.'
        : 'Heuristic: a hole-card rank matches the board and call pot odds are at most 25%; this is not a win-probability estimate.';
  } else {
    selected = chooseFallback(candidates);
    explanation = 'Heuristic: no configured value condition; use the legal conservative fallback.';
  }
  return {
    candidateId: selected.id,
    selected: selected.id,
    source: 'baseline',
    explanation,
    latencyMs: 0,
  };
}
export class BaselinePolicy implements Policy {
  async decide(
    context: DecisionContext,
    candidates: Candidate[],
    options: DecisionOptions = {},
  ): Promise<Proposal> {
    options.signal?.throwIfAborted();
    return chooseBaseline(context, candidates);
  }
}
