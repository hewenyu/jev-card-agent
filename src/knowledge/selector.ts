import type { KnowledgePin, StrategyCard } from './types.js';
export function selectStrategyCards(pin: KnowledgePin, street: string): StrategyCard[] {
  return pin.strategyCards.filter((card) => card.street === 'all' || card.street === street);
}
export const BASE_CARDS: StrategyCard[] = [
  {
    id: 'price-v1',
    street: 'all',
    text: 'Use the actual additional investment and eligible contestable pot. Prior investment is sunk; unavailable side pots cannot justify a call.',
  },
  {
    id: 'evidence-v1',
    street: 'all',
    text: 'Opponent observations have bounded samples and selected showdowns. Missing prices or small samples do not establish a bluff rate.',
  },
  {
    id: 'preflop-v1',
    street: 'preflop',
    text: 'Consider position, remaining players and effective depth. Raising requires a value or credible fold-equity reason; large commitments require stronger continuing ranges.',
  },
  {
    id: 'flop-v1',
    street: 'flop',
    text: 'Assess actual hole-card contribution, draw quality, price and players still active. A named pair or draw alone is not a reason to continue.',
  },
  {
    id: 'turn-v1',
    street: 'turn',
    text: 'Reassess how the turn changes plausible continuing ranges. Do not chase prior investment; distinguish clean draws from dominated outs.',
  },
  {
    id: 'river-v1',
    street: 'river',
    text: 'There are no future cards. A bluff-catcher needs enough plausible worse betting hands at the current price; loose preflop play alone does not establish river bluffs.',
  },
];
