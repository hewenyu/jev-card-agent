import {
  buildQuestions,
  digest,
  evaluateAnswers,
  seededRandom,
  validateStrategy,
  type DecisionPolicy,
  type DomainDefinition,
  type EvaluationAdapter,
  type Features,
} from 'duelloop';
import { performance } from 'node:perf_hooks';
import type { SessionTurn } from '../../core/session.js';
import type { OpponentStats } from '../../core/types.js';
import type { OpponentMemory } from '../../core/opponent-memory.js';
import { buildPokerInput } from '../../poker/input.js';
import { buildPokerContext } from '../../poker/context.js';
import { withModelDeadline } from '../../duelloop/live/model.js';
import { PokerHand } from './engine.js';
import { opponentAction, OPPONENT_SUITES } from './opponents.js';
import { pokerRandom, shuffleDeck } from './random.js';
import {
  DEFAULT_EVALUATION_RULES,
  validateEvaluationRules,
  type PokerEvaluationRules,
} from './protocol.js';
import { EvaluationUsage } from './usage.js';

export interface PokerEvaluatorOptions {
  domain: DomainDefinition;
  decisionPolicy: DecisionPolicy;
  rules?: PokerEvaluationRules;
}

/** Reject unsupported state instead of claiming the live online updater was simulated. */
function frozenKnowledge(input: Features): {
  opponents: OpponentStats[];
  opponentMemory: OpponentMemory[];
} {
  const allowed = new Set(['opponents', 'opponentMemory']);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error('Unsupported frozen poker knowledge field');
  // Valid domain snapshots are produced by the shared facts builder. Never coerce arbitrary objects.
  const opponents = input.opponents ?? [];
  const opponentMemory = input.opponentMemory ?? [];
  if (!Array.isArray(opponents) || !Array.isArray(opponentMemory))
    throw new Error('Invalid frozen poker knowledge');
  if (
    opponents.some(
      (p) =>
        !p ||
        typeof p !== 'object' ||
        Array.isArray(p) ||
        typeof p.name !== 'string' ||
        ['hands', 'vpip', 'pfr', 'facedBet', 'foldedToBet', 'lastTableSeq'].some(
          (key) => typeof p[key] !== 'number' || !Number.isFinite(p[key]),
        ),
    )
  )
    throw new Error('Invalid frozen opponent statistics');
  // Synthetic benchmark identities must not accidentally inherit evidence about real people.
  if (opponentMemory.length)
    throw new Error('Historical encounter memory is not transferable to synthetic opponents');
  if (opponents.some((p) => !/^player-[0-5]$/.test((p as { name: string }).name)))
    throw new Error('Opponent statistics do not match simulation identities');
  return {
    opponents: structuredClone(opponents) as unknown as OpponentStats[],
    opponentMemory: [],
  };
}

async function withinDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Each episode is one independent seed block; SDK pairs baseline and candidate episodes. */
export function createPokerEvaluator(options: PokerEvaluatorOptions): EvaluationAdapter {
  const rules = validateEvaluationRules(options.rules ?? DEFAULT_EVALUATION_RULES);
  const policy = structuredClone(options.decisionPolicy);
  if (
    !Number.isFinite(policy.maxDecisionMs) ||
    policy.maxDecisionMs <= 0 ||
    !Number.isFinite(policy.executionReserveMs) ||
    policy.executionReserveMs < 0 ||
    policy.executionReserveMs >= policy.maxDecisionMs
  )
    throw new Error('Invalid evaluation decision policy');
  const domain = options.domain;
  return {
    id: `poker-six-max-session-v2:${digest(rules)}`,
    decisionPolicy: policy,
    domainDependencies: {
      rules: domain.rulesVersion,
      featureBuilder: domain.featureBuilderVersion,
      knowledgeUpdater: domain.knowledgeUpdaterVersion,
      continuationPolicy: domain.continuationVersion,
      contextDigest: digest(domain.context),
    },
    async episode(input) {
      input.signal.throwIfAborted();
      if (input.knowledgeStateMode !== 'frozen')
        throw new Error('Online knowledge updates are unsupported by this evaluator');
      if (
        !Number.isSafeInteger(input.seed) ||
        !Number.isSafeInteger(input.trajectories) ||
        input.trajectories < 1
      )
        throw new Error('Invalid evaluation episode');
      const suite = OPPONENT_SUITES[input.opponentId];
      if (!suite) throw new Error('Unknown versioned opponent suite');
      validateStrategy(input.strategy, domain);
      if (
        input.strategy.decision.selection.mode === 'softmax_sample' &&
        policy.randomSeed === undefined
      )
        throw new Error('Reproducible softmax evaluation requires a release-bound random seed');
      const knowledge = frozenKnowledge(input.knowledge);
      const usage = new EvaluationUsage();
      const decisionComputeLatenciesMs: number[] = [];
      let modelCalls = 0;
      let profit = 0;
      const seating = pokerRandom('poker-evaluation-v1', input.seed, 'seating');
      const heroSeat = Math.floor(seating() * 6);
      const initialDealer = Math.floor(seating() * 6);
      const opponentOffset = Math.floor(seating() * 5);
      for (let handIndex = 0; handIndex < input.trajectories; handIndex++) {
        input.signal.throwIfAborted();
        const hand = new PokerHand({
          deck: shuffleDeck(input.seed, handIndex),
          dealer: (initialDealer + handIndex) % 6,
          stacks: rules.startingStacks,
          smallBlind: rules.smallBlind,
          bigBlind: rules.bigBlind,
          handId: `simulation-hand-${handIndex}`,
        });
        const counts = Array<number>(6).fill(0);
        // Every hand in every baseline/candidate episode owns a fresh mutable history.
        const previousTurns: SessionTurn[] = [];
        while (!hand.complete) {
          input.signal.throwIfAborted();
          const seat = hand.actor!;
          const state = hand.view(seat);
          const candidates = hand.candidates();
          const ordinal = counts[seat]!;
          counts[seat] = ordinal + 1;
          if (seat !== heroSeat) {
            const relative = (seat - heroSeat + 5) % 6;
            const style = suite[(relative + opponentOffset) % 5]!;
            hand.act(
              opponentAction(
                style,
                state,
                candidates,
                pokerRandom(
                  'poker-evaluation-v1',
                  input.seed,
                  handIndex,
                  'opponent',
                  seat,
                  state.street,
                  ordinal,
                ),
              ),
            );
            continue;
          }
          const started = performance.now();
          const observedAt = Date.now();
          const authorityDeadline = observedAt + policy.maxDecisionMs;
          const modelDeadline = authorityDeadline - policy.executionReserveMs;
          const signal = AbortSignal.any([
            input.signal,
            AbortSignal.timeout(Math.max(1, modelDeadline - Date.now())),
          ]);
          const context = buildPokerContext(state, {
            opponents: knowledge.opponents,
            opponentMemory: knowledge.opponentMemory,
            previousTurns,
          });
          const { observation, candidates: actions } = buildPokerInput(context, candidates, {
            applicationId: 'jev-card-agent-simulation',
            scopeId: 'simulation',
            actorId: `player-${heroSeat}`,
            streamId: 'simulation-six-max',
            trajectoryId: state.handId!,
            revision: digest(state),
            observedAt,
            authorityDeadline,
            factsSnapshotDigest: digest(input.knowledge),
          });
          const questions = buildQuestions(input.strategy, observation, actions, domain);
          signal.throwIfAborted();
          if (Date.now() >= modelDeadline) throw new Error('Evaluation model deadline exceeded');
          modelCalls++;
          const response = await withinDeadline(signal, () =>
            withModelDeadline(modelDeadline, () => input.model.score({ ...questions, signal })),
          );
          usage.add(response.usage);
          signal.throwIfAborted();
          if (Date.now() >= modelDeadline) throw new Error('Evaluation model deadline exceeded');
          if (input.model.kind === 'real' && response.model !== input.model.id)
            throw new Error('Evaluation model identity mismatch');
          if (Object.keys(response.answers).length !== questions.questions.length)
            throw new Error('Evaluation answer set mismatch');
          const selected = evaluateAnswers(
            input.strategy,
            observation,
            actions,
            response.answers,
            policy.randomSeed === undefined
              ? undefined
              : seededRandom(
                  `${policy.randomSeed}:${observation.trajectoryId}:${observation.revision}`,
                ),
          );
          signal.throwIfAborted();
          const action = candidates.find((candidate) => candidate.id === selected.action.id);
          if (!action) throw new Error('Model selected unknown action');
          decisionComputeLatenciesMs.push(performance.now() - started);
          hand.act(action);
          // Only applied actions enter the next request; never append a proposal before act succeeds.
          previousTurns.push({
            decisionId: `simulation-${handIndex}-${ordinal}`,
            createdAt: new Date(observedAt).toISOString(),
            tableSeq: state.lastTableSeq,
            street: state.street,
            status: 'accepted',
            source: 'jev',
            fallbackReason: null,
            action: {
              kind: action.action,
              ...(action.amount === undefined ? {} : { raiseToChips: action.amount }),
            },
            analysis: null,
            analysisTruncated: false,
          });
        }
        profit += hand.finalStacks[heroSeat]! - rules.startingStacks[heroSeat]!;
      }
      return {
        reward: (profit / rules.bigBlind / input.trajectories) * 100,
        decisions: decisionComputeLatenciesMs.length,
        decisionComputeLatenciesMs,
        modelCalls,
        usage: usage.value(),
      };
    },
  };
}
