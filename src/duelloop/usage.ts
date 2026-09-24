import type { ModelUsage } from 'duelloop';

const tokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const dollars = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Empty accumulation has no calls; a call without usage must still be added. */
export function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    unknown: false,
    knownCostUsd: 0,
    costUsd: 0,
    costUnknown: false,
  };
}

/** Only validated numbers enter accounting. A known subtotal is not a complete bill. */
export function normalizeUsage(value: unknown): ModelUsage {
  const source = value && typeof value === 'object' ? (value as ModelUsage) : {};
  const input = tokens(source.inputTokens),
    output = tokens(source.outputTokens);
  const known = dollars(source.knownCostUsd),
    complete = dollars(source.costUsd);
  const costUnknown =
    source.costUnknown === true ||
    !complete ||
    (source.knownCostUsd !== undefined && (!known || source.knownCostUsd !== source.costUsd));
  return {
    ...(input ? { inputTokens: source.inputTokens } : {}),
    ...(output ? { outputTokens: source.outputTokens } : {}),
    unknown: source.unknown === true || !input || !output,
    knownCostUsd: known ? source.knownCostUsd : complete ? source.costUsd : 0,
    costUnknown,
    ...(!costUnknown ? { costUsd: source.costUsd } : {}),
  };
}

export function accumulateUsage(total: ModelUsage, value: unknown): void {
  const measured = normalizeUsage(value);
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    const next = (total[key] ?? 0) + (measured[key] ?? 0);
    if (tokens(next)) total[key] = next;
    else total.unknown = true;
  }
  total.unknown = total.unknown === true || measured.unknown === true;
  const cost = (total.knownCostUsd ?? 0) + measured.knownCostUsd!;
  if (dollars(cost)) total.knownCostUsd = cost;
  total.costUnknown = total.costUnknown === true || measured.costUnknown === true || !dollars(cost);
  if (total.costUnknown) delete total.costUsd;
  else total.costUsd = total.knownCostUsd;
}
