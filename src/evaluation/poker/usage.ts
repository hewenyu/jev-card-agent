import type { ModelUsage } from 'duelloop';

/** Dollar completeness and token completeness are independent, including absent usage. */
export class EvaluationUsage {
  #input = 0;
  #output = 0;
  #knownCost = 0;
  #unknown = false;
  #costUnknown = false;
  add(usage?: ModelUsage): void {
    const input = usage?.inputTokens;
    const output = usage?.outputTokens;
    const completeTokens =
      Number.isFinite(input) && input! >= 0 && Number.isFinite(output) && output! >= 0;
    this.#input += Number.isFinite(input) && input! >= 0 ? input! : 0;
    this.#output += Number.isFinite(output) && output! >= 0 ? output! : 0;
    this.#unknown ||= !completeTokens || usage?.unknown === true;
    const cost = usage?.costUsd;
    const known = usage?.knownCostUsd;
    const completeCost = Number.isFinite(cost) && cost! >= 0 && usage?.costUnknown !== true;
    this.#knownCost += completeCost ? cost! : Number.isFinite(known) && known! >= 0 ? known! : 0;
    this.#costUnknown ||= !completeCost;
  }
  value(): ModelUsage {
    return {
      inputTokens: this.#input,
      outputTokens: this.#output,
      knownCostUsd: this.#knownCost,
      ...(this.#costUnknown ? {} : { costUsd: this.#knownCost }),
      unknown: this.#unknown,
      costUnknown: this.#costUnknown,
    };
  }
}
