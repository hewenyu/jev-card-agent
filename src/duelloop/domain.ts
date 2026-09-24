import { digest, type CandidateAction, type DomainDefinition, type Observation } from 'duelloop';
import type { ReplaySample } from './plan.js';

export const POKER_REPLAY_APPLICATION_ID = 'jev-card-agent-shadow';
export const POKER_REPLAY_SCOPE_ID = 'openpoker-archived-decisions';
export const POKER_REPLAY_DOMAIN_ID = 'openpoker-history';
export const POKER_REPLAY_RULES_VERSION = 'six-max-nlhe-v2';
export const POKER_REPLAY_FEATURE_CONTRACT = 'archived-jev-input-v1';

/** This domain has no connection, execution credential, or counterfactual evaluator. */
export function createPokerReplayDomain(): DomainDefinition {
  return {
    id: POKER_REPLAY_DOMAIN_ID,
    rulesVersion: POKER_REPLAY_RULES_VERSION,
    featureContract: POKER_REPLAY_FEATURE_CONTRACT,
    featureBuilderVersion: 'frozen-request-envelope-v1',
    knowledgeUpdaterVersion: 'archived-only-v1',
    continuationVersion: 'archived-poker-guidance-v1',
    features: {
      poker: { type: 'object', required: true },
      pokerInstructions: { type: 'object', required: true },
    },
    context: {
      rules: 'Recorded six-max No-Limit Texas Hold’em on OpenPoker WebSocket V2.',
      visibility:
        'poker contains only the archived request state available at the original action. Unknown cards, future actions and final outcomes are unavailable. Preserve uncertainty and sample qualifications.',
      instructions:
        'pokerInstructions.archived contains the original poker guidance. Apply that guidance when scoring each priced candidate; the present Score contract replaces its request to select one Choice.',
      units:
        'Candidate parameters preserve archived chip amounts, raise-to totals, additional commitment and price qualifications without recalculation. Scores are ordinal quality, not calibrated chip EV or poker win probabilities.',
      continuation:
        'Evaluate the current candidate using the archived poker guidance for hypothetical later decisions; do not assume knowledge of the actual subsequent trajectory.',
      replay:
        'observedAt and deadline are replay computation timestamps, not live action authority. No shadow action is submitted to OpenPoker.',
    },
    capabilities: {
      execution: false,
      idempotency: false,
      statusQuery: false,
      delayedFeedback: false,
      revisedFeedback: false,
      activationBoundary: 'trajectory',
      evaluation: false,
    },
    async observe() {
      throw new Error('Replay requires an explicitly supplied frozen observation');
    },
    async candidates() {
      throw new Error('Replay requires explicitly supplied archived candidates');
    },
  };
}

/** Whitelist model inputs: source choices and eventual hand outcomes never enter features. */
export function replayInput(
  sample: ReplaySample,
  timeoutMs: number,
): { observation: Observation; candidates: CandidateAction[] } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Replay timeout must be a positive integer');
  if (digest(sample.request) !== sample.inputHash)
    throw new Error('Archived request digest mismatch');
  const criteria = sample.request.questions.action.criteria;
  if (
    sample.candidates.length === 0 ||
    new Set(sample.candidates.map((candidate) => candidate.id)).size !== sample.candidates.length ||
    Object.keys(criteria).length !== sample.candidates.length
  )
    throw new Error('Archived candidates and criteria must match');
  const candidates: CandidateAction[] = sample.candidates.map((candidate) => {
    const parameters = criteria[candidate.id];
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
      throw new Error('Archived priced candidate must be an object');
    if (parameters.action !== candidate.action)
      throw new Error('Archived candidate action mismatch');
    return {
      id: candidate.id,
      kind: candidate.action,
      parameters: structuredClone(parameters),
      revision: sample.inputHash,
    };
  });
  const now = Date.now();
  return {
    observation: {
      applicationId: POKER_REPLAY_APPLICATION_ID,
      domainId: POKER_REPLAY_DOMAIN_ID,
      strategyScopeId: POKER_REPLAY_SCOPE_ID,
      streamId: `${sample.runId}:${sample.tableId}`,
      actorId: 'hero',
      trajectoryId: `${sample.runId}:${sample.handId}`,
      revision: sample.inputHash,
      observedAt: now,
      deadline: now + timeoutMs,
      features: {
        poker: structuredClone(sample.request.state),
        pokerInstructions: {
          archived: structuredClone(sample.request.questions.action.instructions),
        },
      },
    },
    candidates,
  };
}
