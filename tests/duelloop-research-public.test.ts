import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { publicResearchView } from '../src/duelloop/research/public-view.js';
import type { ResearchServiceStatus } from '../src/duelloop/research/service.js';
import type { FrameworkDecisionView } from '../src/shared/framework.js';
import { FrameworkDecision } from '../web/src/components/FrameworkDecision.js';
import { FrameworkStatus } from '../web/src/components/FrameworkStatus.js';

describe('public framework projections', () => {
  it('publishes status counts but no private run data, prompt, credential or validation body', () => {
    const status = {
      enabled: true,
      running: true,
      paused: false,
      error: null,
      updatedAt: '2026-09-24T00:00:00.000Z',
      research: {
        state: 'idle',
        provider: 'deepseek/messages/deepseek-flash',
        activeRun: null,
        latestRuns: [
          {
            id: 'run-id',
            status: 'no_change',
            createdAt: 1,
            updatedAt: 2,
            counters: { tokens: 12, modelCalls: 1 },
            data: { apiKey: 'do-not-show', prompt: 'private-evidence' },
          },
        ],
        pendingReleases: [
          {
            digest: 'release-id',
            validationDigest: 'validation-id',
            dependencies: { secret: 'private-dependencies' },
          },
        ],
        activation: { activationMode: 'explicit', activationPaused: false },
      },
    } as unknown as ResearchServiceStatus;
    const view = publicResearchView(status);
    expect(view.recentRuns[0]).toMatchObject({ modelCalls: 1, evaluationCalls: 0, tokens: 12 });
    expect(JSON.stringify(view)).not.toMatch(/do-not-show|private-evidence|private-dependencies/);
    const html = renderToStaticMarkup(
      createElement(FrameworkStatus, {
        framework: {
          engine: 'duelloop',
          activeReleaseDigest: 'active',
          handReleaseDigest: 'pinned',
          factsSnapshotDigest: 'facts',
          unresolvedIntents: 0,
          research: view,
        },
      }),
    );
    expect(html).toContain('Explicit operator approval');
    expect(html).toContain('Validated proposals awaiting activation');
    expect(html).not.toContain('<button');
  });
  it('shows unknown costs and distinguishes argmax from model confidence', () => {
    const view: FrameworkDecisionView = {
      decisionId: 'decision',
      releaseDigest: 'release',
      strategyDigest: 'strategy',
      factsSnapshotDigest: 'facts',
      selection: 'argmax',
      branchId: null,
      scores: [
        { candidateId: 'fold', dimensionId: 'quality', score: 3, levels: 5, confidence: 0.7 },
      ],
      utilities: { fold: 0.75 },
      selectionProbabilities: { fold: 1 },
      modelDeadline: null,
      usage: {
        inputTokens: 100,
        outputTokens: 4,
        tokensComplete: true,
        costUsd: null,
        costComplete: false,
      },
    };
    const html = renderToStaticMarkup(createElement(FrameworkDecision, { framework: view }));
    expect(html).toContain('Unknown / incomplete');
    expect(html).toContain('70.0%');
    expect(html).toContain('it is not 100% model confidence');
    expect(html).not.toContain('$0.000000');
  });
});
