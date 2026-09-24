import type { CandidateAction, Features, Observation } from 'duelloop';
import type { Candidate, DecisionContext } from '../core/types.js';
import { candidateCriteria, projectJevState } from '../core/harness.js';
import { POKER_APPLICATION_ID, POKER_DOMAIN_ID } from './domain.js';

function jsonFeatures(value: unknown): Features {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item))
        throw new Error('Poker facts must contain finite numbers');
      return item;
    }),
  ) as Features;
}

export interface PokerInputIdentity {
  applicationId?: string;
  scopeId: string;
  actorId: string;
  streamId: string;
  trajectoryId: string;
  revision: string;
  observedAt: number;
  authorityDeadline: number;
  factsSnapshotDigest: string;
}

/** Strip legacy strategy preferences, identifiers and authority before model projection. */
export function buildPokerInput(
  original: DecisionContext,
  candidates: Candidate[],
  identity: PokerInputIdentity,
): { observation: Observation; candidates: CandidateAction[] } {
  const context = structuredClone(original);
  delete context.advice;
  delete context.knowledge;
  const state = projectJevState(context);
  const harness = state.harness as Record<string, unknown>;
  harness.opponentGuidance = (context.harness?.opponentGuidance ?? []).map(
    ({ adjustmentHypothesis: _hypothesis, ...fact }) => fact,
  );
  const criteria = candidateCriteria(context, candidates);
  const priced = candidates.map((candidate) => {
    const {
      fitsWhen: _preference,
      warning: _warning,
      benefit: _benefit,
      ...facts
    } = criteria[candidate.id]!;
    return {
      id: candidate.id,
      kind: candidate.action,
      parameters: jsonFeatures(facts),
      revision: identity.revision,
    };
  });
  return {
    observation: {
      applicationId: identity.applicationId ?? POKER_APPLICATION_ID,
      domainId: POKER_DOMAIN_ID,
      strategyScopeId: identity.scopeId,
      streamId: identity.streamId,
      actorId: identity.actorId,
      trajectoryId: identity.trajectoryId,
      revision: identity.revision,
      observedAt: identity.observedAt,
      deadline: identity.authorityDeadline,
      features: {
        poker: jsonFeatures(state),
        facts: { digest: identity.factsSnapshotDigest, cutoff: original.asOf ?? null },
      },
    },
    candidates: priced,
  };
}
