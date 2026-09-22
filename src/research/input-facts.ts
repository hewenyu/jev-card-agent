import { BASE_CARDS } from '../knowledge/selector.js';
type Raw = Record<string, unknown>;
const object = (value: unknown): Raw =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const ids = new Set(BASE_CARDS.map((card) => card.id));
/** Extract actual archived numerical inputs, never recompute what the model supposedly saw. */
export function actualInputFacts(request: Raw, selected: unknown) {
  if (!Object.keys(request).length) return null;
  const state = object(request.state),
    harness = object(state.harness),
    betting = object(harness.betting);
  const entries = Object.entries(object(object(object(request.questions).action).criteria));
  const ordered = [
    ...entries.filter(([id]) => id === selected),
    ...entries.filter(([id]) => id !== selected),
  ];
  return {
    betting: {
      potChips: finite(betting.potChips),
      heroStackChips: finite(betting.heroStackChips),
      heroStreetBetChips: finite(betting.heroStreetBetChips),
      callChips: finite(betting.callChips),
      contestablePotBeforeCallChips: finite(betting.contestablePotBeforeCallChips),
      inaccessibleCurrentWagersChips: finite(betting.inaccessibleCurrentWagersChips),
      requiredEquityToCall: finite(betting.requiredEquityToCall),
      activeOpponents: finite(betting.activeOpponents),
      callConsumesStack: boolean(betting.callConsumesStack),
      sidePotsPossible: boolean(betting.sidePotsPossible),
    },
    criteria: ordered.slice(0, 8).map(([id, value]) => {
      const criterion = object(value);
      return {
        selected: id === selected,
        action: ['fold', 'check', 'call', 'raise', 'all_in'].includes(String(criterion.action))
          ? criterion.action
          : null,
        additionalChips: finite(criterion.additionalChips),
        additionalBb: finite(criterion.additionalBb),
        stackFraction: finite(criterion.stackFraction),
        raiseToChips: finite(criterion.raiseToChips),
        requiredShowdownShare: finite(criterion.requiredShowdownShare),
      };
    }),
    criteriaOmitted: Math.max(0, entries.length - 8),
    referenceIds: array(object(state.knowledge).references)
      .map(object)
      .map((card) => card.id)
      .filter((id): id is string => typeof id === 'string' && ids.has(id)),
  };
}
