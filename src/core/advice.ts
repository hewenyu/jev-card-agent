import type { AdviceBundle, AdviceSelection, AsyncLlmMode } from '../knowledge/advice-types.js';
import { selectAdvice } from '../knowledge/advice-selector.js';
import { opponentKey } from '../knowledge/advice-validator.js';
import { RULESET_VERSION } from '../knowledge/validator.js';
import { activeSeats, positionFacts } from './poker-math.js';
import type { DecisionContext } from './types.js';

export interface DecisionAdvice extends AdviceSelection {
  mode: AsyncLlmMode;
  bundleHash: string;
  selectorVersion: string;
  selectionAt: string;
  knowledgeSource: 'deterministic' | 'llm-assisted';
  publicationIds: string[];
  proposalIds: string[];
}
/** Local scope selection from the already fixed archive; never reads newer research. */
export function applyAdvice(
  context: DecisionContext,
  bundle: AdviceBundle,
  selectionAt?: string,
): void {
  const at = selectionAt ?? context.knowledge?.pin.admissibleAt ?? context.asOf;
  if (!at) throw new Error('Advice selection requires an explicit admissible time');
  const active = activeSeats(context.seats);
  // Waiting occupants cannot establish a positional scope. Folded dealt seats remain in roster.
  const position = positionFacts({
    ...context,
    seats: context.seats.filter((seat) => seat.inHand !== false),
  }).hero;
  const stackBb =
    context.effectiveStack !== null && context.bigBlind > 0
      ? context.effectiveStack / context.bigBlind
      : null;
  const priceRatio = context.pot > 0 ? context.toCall / context.pot : null;
  const result = selectAdvice(
    bundle,
    {
      street: context.street,
      players: active.length,
      ...(position ? { position: position === 'BTN/SB' ? 'BTN' : position } : {}),
      ...(stackBb !== null
        ? { stackBucket: stackBb < 40 ? 'short' : stackBb <= 100 ? 'medium' : 'deep' }
        : {}),
      ...(context.toCall === 0
        ? { betBucket: 'none' }
        : priceRatio !== null
          ? { betBucket: priceRatio <= 0.33 ? 'small' : priceRatio <= 0.75 ? 'medium' : 'large' }
          : {}),
      opponentKeys: active
        .filter((seat) => seat.seat !== context.heroSeat && seat.name !== null)
        .map((seat) => opponentKey(seat.name!)),
      rulesetVersion: RULESET_VERSION,
      basePolicyVersion: bundle.basePolicyVersion,
    },
    at,
  );
  context.advice = {
    ...result,
    mode: bundle.mode,
    bundleHash: bundle.bundleHash,
    selectorVersion: bundle.selectorVersion,
    selectionAt: at,
    knowledgeSource: result.items.length ? 'llm-assisted' : 'deterministic',
    publicationIds: result.items.map((item) => item.id),
    proposalIds: result.items.map(
      (selected) =>
        bundle.publications.find((item) => item.publicationId === selected.id)!.proposalId,
    ),
  };
}
