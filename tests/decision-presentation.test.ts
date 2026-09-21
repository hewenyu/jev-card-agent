import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionView } from '../src/shared/api.js';
import { Decision } from '../web/src/components/Decision.js';

const decision: DecisionView = {
  id: 'test-decision',
  runId: 'test-run',
  handId: 'test-hand',
  street: 'flop',
  createdAt: '2025-01-01T00:00:00Z',
  context: {},
  candidates: [
    { id: 'raise-80', label: 'Raise to 80', action: { kind: 'raise', raiseToChips: 80 } },
  ],
  selectedCandidateId: 'raise-80',
  source: 'jev',
  probabilities: { 'raise-80': 1 },
  confidence: 1,
  status: 'accepted',
  latencyMs: 10,
  costUsd: 0,
  fallbackReason: null,
  model: 'jev-1.13.0',
};
const render = (value: Partial<DecisionView> = {}) =>
  renderToStaticMarkup(createElement(Decision, { decision: { ...decision, ...value } }));

describe('decision presentation distinguishes requests, retries and submissions', () => {
  it('labels the initial call and each bounded retry independently from the provider step number', () => {
    const output = render({
      attempts: [0, 1, 2, 3].map((retryIndex) => ({
        provider: 'jev',
        purpose: 'reconsider',
        requestedModel: 'jev-1.13.0',
        actualModel: null,
        status: retryIndex === 3 ? 'succeeded' : 'failed',
        latencyMs: 20,
        retryIndex,
        maxRetries: 3,
      })),
    });
    expect(output).toContain('Initial attempt');
    expect(output).toContain('Retry 1 of 3');
    expect(output).toContain('Retry 2 of 3');
    expect(output).toContain('Retry 3 of 3');
  });

  it('does not invent retry metadata for older records', () => {
    const output = render({
      attempts: [
        {
          provider: 'jev',
          requestedModel: 'legacy-model',
          actualModel: 'legacy-model',
          status: 'succeeded',
          latencyMs: 12,
        },
      ],
    });
    expect(output).toContain('legacy-model');
    expect(output).not.toContain('Initial attempt');
    expect(output).not.toContain('Retry 1');
  });

  it('shows a cancelled suggestion as unsubmitted and never marks its candidate as selected', () => {
    const output = render({
      status: 'cancelled',
      fallbackReason: 'authority_changed',
      routing: { outcome: 'reconsidered', initialCandidateId: 'check' },
    });
    expect(output).toContain('Cancelled · no action submitted');
    expect(output).toContain('Cancellation reason');
    expect(output).toContain('authority_changed');
    expect(output).toContain('Unsubmitted recommendation: Raise to 80');
    expect(output).toContain('Decision cancelled before submission');
    expect(output).not.toContain('SELECTED');
    expect(output).not.toContain('Jev changed its choice after analysis.');
    expect(output).not.toContain('Fallback:');
  });

  it('identifies cancelled traces without a selected action, but does not assume missing legacy actions were cancelled', () => {
    expect(render({ status: 'cancelled', selectedCandidateId: null })).toContain(
      'Cancelled · no action submitted',
    );
    const unknown = render({ status: 'unresolved', selectedCandidateId: null });
    expect(unknown).toContain('No action recorded');
    expect(unknown).not.toContain('Cancelled · no action submitted');
    const accepted = render();
    expect(accepted).toContain('<h3>Raise to 80</h3>');
    expect(accepted).toContain('SELECTED');
  });
});
