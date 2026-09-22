/** Research produces proposals only: no runtime, action sender or credentials are in this contract. */
export interface ResearchBatch {
  baseVersion: string;
  evidenceEventId: number;
  evidenceIds: string[];
  summaries: ReadonlyArray<Record<string, unknown>>;
}
export interface ResearchProposal {
  baseVersion: string;
  evidenceEventId: number;
  evidenceIds: string[];
  hypothesis: string;
  scope: string[];
  suggestedCards: Array<{ id: string; street: string; text: string }>;
  requiredScenarios: string[];
}
export interface ResearchProvider {
  propose(batch: ResearchBatch, signal: AbortSignal): Promise<ResearchProposal>;
}
