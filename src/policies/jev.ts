import { z } from 'zod';
import type {
  Candidate,
  DecisionContext,
  DecisionOptions,
  Policy,
  Proposal,
  ProviderMeter,
  RawMessage,
} from '../core/types.js';
import { beginAttempt, endpoint, ProviderError } from './metering.js';
import { STRATEGY_VERSIONS } from '../core/index.js';
import { MODEL_MAX_RETRIES, withProviderRetries } from './retry.js';
import { awaitWithAbort } from './abort.js';
import { candidateCriteria, POKER_INSTRUCTIONS, projectJevState } from '../core/harness.js';

export const QUESTION_VERSION = STRATEGY_VERSIONS.prompt;
export interface JevConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  meter?: ProviderMeter;
  maxRetries?: number;
}
const choiceSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const responseSchema = z.object({
  model: z.string().min(1),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  answers: z.object({ action: choiceSchema, needs_analysis: choiceSchema.optional() }),
});
const metadataSchema = responseSchema.pick({ model: true, usage: true });
export interface RoutedDecision {
  proposal: Proposal;
  needsReasoning: boolean;
}
export interface RoutingJev extends Policy {
  decideWithRouting(
    context: DecisionContext,
    candidates: Candidate[],
    options?: DecisionOptions,
  ): Promise<RoutedDecision>;
  reconsider(
    context: DecisionContext,
    candidates: Candidate[],
    advisory: string,
    options?: DecisionOptions,
  ): Promise<Proposal>;
}
function validateChoice(answer: z.infer<typeof choiceSchema>, ids: Set<string>): void {
  const distribution = Object.entries(answer.probabilities);
  if (
    !ids.has(answer.choice) ||
    distribution.length !== ids.size ||
    distribution.some(([id]) => !ids.has(id))
  )
    throw new ProviderError('Jev returned an unknown or incomplete candidate distribution');
  if (Math.abs(distribution.reduce((sum, [, p]) => sum + p, 0) - 1) > 0.01)
    throw new ProviderError('Jev probabilities do not sum to one');
  const selected = answer.probabilities[answer.choice];
  if (selected === undefined || distribution.some(([, p]) => p > selected + 1e-6))
    throw new ProviderError('Jev choice does not match its highest probability');
}
export class JevProvider implements RoutingJev {
  private readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: JevConfig) {
    if (!config.apiKey.trim()) throw new Error('Jev API key is required');
    this.model = config.model ?? 'jev-1.13.0';
    this.url = endpoint(config.baseUrl ?? 'https://api.typesafe.ai', 'systemone');
    this.timeoutMs = config.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error('Invalid Jev timeout');
    this.fetcher = config.fetch ?? globalThis.fetch;
  }
  decide(
    context: DecisionContext,
    candidates: Candidate[],
    options: DecisionOptions = {},
  ): Promise<Proposal> {
    return this.evaluate(context, candidates, options, false);
  }
  async decideWithRouting(
    context: DecisionContext,
    candidates: Candidate[],
    options: DecisionOptions = {},
  ): Promise<RoutedDecision> {
    const proposal = await this.evaluate(context, candidates, options, true);
    return { proposal, needsReasoning: proposal.routing?.needsReasoning === true };
  }
  reconsider(
    context: DecisionContext,
    candidates: Candidate[],
    advisory: string,
    options: DecisionOptions = {},
  ): Promise<Proposal> {
    return this.evaluate(context, candidates, options, false, advisory);
  }
  private async evaluate(
    context: DecisionContext,
    candidates: Candidate[],
    options: DecisionOptions,
    route: boolean,
    advisory?: string,
  ): Promise<Proposal> {
    const started = performance.now();
    const { value, attempts } = await withProviderRetries(
      async (retryIndex) => {
        const value = await this.evaluateOnce(
          context,
          candidates,
          options,
          route,
          advisory,
          retryIndex,
        );
        return { value, attempt: value.attempts![0]! };
      },
      { ...options, phase: 'jev', maxRetries: this.config.maxRetries },
    );
    return { ...value, attempts, latencyMs: Math.round(performance.now() - started) };
  }
  private async evaluateOnce(
    context: DecisionContext,
    candidates: Candidate[],
    options: DecisionOptions,
    route: boolean,
    advisory?: string,
    retryIndex = 0,
  ): Promise<Proposal> {
    options.signal?.throwIfAborted();
    if (!candidates.length || new Set(candidates.map((c) => c.id)).size !== candidates.length)
      throw new Error('Unique nonempty candidates required');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const questions: RawMessage = {
      action: {
        type: 'choice',
        instructions: POKER_INSTRUCTIONS,
        criteria: candidateCriteria(context, candidates),
      },
    };
    if (route)
      questions.needs_analysis = {
        type: 'choice',
        instructions:
          'Would a separate reasoning model’s brief analysis materially improve this decision within the remaining action time? Decide from strategic ambiguity and incomplete evidence, not monetary cost or a fixed numerical confidence threshold. The first action choice remains available if analysis cannot finish.',
        criteria: {
          yes: 'Request an additional analysis before a final Jev decision.',
          no: 'Use the current Jev action directly; additional analysis is unnecessary.',
        },
      };
    const projected = projectJevState(context);
    const request: RawMessage = {
      model: this.model,
      state: advisory === undefined ? projected : { ...projected, untrusted_advisory: advisory },
      questions,
    };
    let advisoryMetadata:
      { originalCharacters: number; usedCharacters: number; truncated: boolean } | undefined;
    if (advisory !== undefined) {
      const prepare = (length: number) => {
        advisoryMetadata = {
          originalCharacters: advisory.length,
          usedCharacters: length,
          truncated: length < advisory.length,
        };
        request.state = {
          ...projected,
          untrusted_advisory: advisory.slice(0, length),
          advisory_metadata: advisoryMetadata,
        };
        return JSON.stringify(request).length;
      };
      if (prepare(0) > 48000) throw new ProviderError('jev_input_too_large');
      let low = 0;
      let high = advisory.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (prepare(middle) <= 48000) low = middle;
        else high = middle - 1;
      }
      prepare(low);
    }
    const serialized = JSON.stringify(request);
    if (serialized.length > 48000) throw new ProviderError('jev_input_too_large');
    const call = beginAttempt(
      {
        provider: 'jev',
        purpose: route ? 'route_and_decision' : advisory === undefined ? 'decision' : 'reconsider',
        requestedModel: this.model,
        inputCharacters: serialized.length,
        maxOutputTokens: route ? 2048 : 1024,
      },
      this.config.meter,
    );
    call.attempt.retryIndex = retryIndex;
    call.attempt.maxRetries = this.config.maxRetries ?? MODEL_MAX_RETRIES;
    let receivedResponse = false;
    let completed: Omit<Proposal, 'latencyMs' | 'attempts'>;
    try {
      const response = await awaitWithAbort(signal, () =>
        this.fetcher(this.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: serialized,
          signal,
          redirect: 'error',
        }),
      );
      receivedResponse = true;
      if (!response.ok) throw new ProviderError(`Jev API returned HTTP ${response.status}`);
      const raw: unknown = await awaitWithAbort(signal, () => response.json());
      signal.throwIfAborted();
      const metadata = metadataSchema.safeParse(raw);
      if (metadata.success) {
        call.attempt.actualModel = metadata.data.model;
        call.attempt.usage = metadata.data.usage;
      }
      const parsed = responseSchema.parse(raw);
      const answer = parsed.answers.action;
      call.attempt.diagnostics = {
        choice: answer.choice,
        probabilities: answer.probabilities,
        probabilitySum: Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0),
        maximumProbability: Math.max(...Object.values(answer.probabilities)),
      };
      validateChoice(answer, new Set(candidates.map((c) => c.id)));
      const gate = parsed.answers.needs_analysis;
      if (route && !gate) throw new ProviderError('Jev route answer missing');
      if (gate) validateChoice(gate, new Set(['yes', 'no']));
      completed = {
        candidateId: answer.choice,
        selected: answer.choice,
        source: 'jev',
        explanation:
          'Jev Choice selected this legal candidate. Its option probabilities and confidence are model outputs, not poker equity or expected profit.',
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        model: parsed.model,
        usage: parsed.usage,
        request,
        response: parsed as unknown as RawMessage,
        ...(route || advisoryMetadata
          ? {
              routing: {
                ...(route ? { needsReasoning: gate?.choice === 'yes', gate } : {}),
                ...(advisoryMetadata ? { advisory: advisoryMetadata } : {}),
              },
            }
          : {}),
      };
    } catch (error) {
      const code = signal.aborted
        ? 'jev_cancelled'
        : error instanceof ProviderError
          ? error.code
          : receivedResponse
            ? 'jev_invalid_response'
            : 'jev_network_error';
      throw new ProviderError(code, call.finish(signal.aborted ? 'cancelled' : 'failed', code));
    }
    // Settlement failures are storage errors, never a reason for another paid request.
    const attempt = call.finish('succeeded');
    return { ...completed, latencyMs: attempt.latencyMs, attempts: [attempt] };
  }
}
