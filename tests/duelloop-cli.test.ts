import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from 'duelloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sdkBaseUrl } from '../src/duelloop/config.js';

function frozenPlan() {
  const request = {
    model: 'jev-1.13.0',
    state: {
      street: 'preflop',
      board: [],
      holeCards: ['Ah', 'Kd'],
      historyIncomplete: false,
    },
    questions: {
      action: {
        type: 'choice',
        instructions: { task: 'Use the visible facts to choose a legal action.' },
        criteria: { check: { action: 'check', additionalChips: 0 } },
      },
    },
  };
  const content = {
    schemaVersion: 'duelloop-poker-shadow-v1',
    preparedAt: '2026-01-02T00:00:00.000Z',
    sourceRunId: 'archived-run',
    sourceMode: 'live',
    selection: 'street_round_robin_then_chronological',
    scanned: 1,
    scanLimitReached: false,
    excluded: {},
    samples: [
      {
        decisionId: 'archived-decision',
        runId: 'archived-run',
        handId: 'archived-hand',
        tableId: 'archived-table',
        street: 'preflop',
        originalAt: '2026-01-01T00:00:00.000Z',
        originalChoice: 'check',
        originalModel: 'jev-1.13.0',
        originalLatencyMs: 100,
        inputHash: digest(request),
        request,
        candidates: [{ id: 'check', action: 'check', label: 'Check' }],
      },
    ],
    historicalOutcomes: [],
  };
  return { ...content, planHash: digest(content) };
}

describe('DuelLoop command-line boundaries', () => {
  let directory: string;
  let planPath: string;
  let blockerPath: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'duelloop-cli-'));
    planPath = join(directory, 'plan.json');
    writeFileSync(planPath, JSON.stringify(frozenPlan()));
    blockerPath = join(directory, 'no-network.mjs');
    writeFileSync(
      blockerPath,
      `import { Socket } from 'node:net';
const forbidden = () => { throw new Error('NETWORK_FORBIDDEN'); };
globalThis.fetch = forbidden;
Socket.prototype.connect = forbidden;
`,
    );
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function cli(args: string[]) {
    return spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(blockerPath).href,
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli/duelloop.ts'),
        ...args,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          JEV_API_KEY: '',
          JEV_BASE_URL: 'intentionally-invalid-unused-endpoint',
        },
      },
    );
  }

  it('prints help without model credentials, a valid endpoint or network', () => {
    const result = cli(['--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no Arena connection');
    expect(result.stderr).not.toContain('NETWORK_FORBIDDEN');
  });

  it('refuses a real run without --allow-paid before accessing credentials or network', () => {
    const output = join(directory, 'real-run');
    const result = cli(['--op', 'run', '--plan', planPath, '--output', output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Real model requests require --allow-paid');
    expect(result.stderr).not.toContain('NETWORK_FORBIDDEN');
    expect(result.stdout).toBe('');
    expect(existsSync(output)).toBe(false);
  });

  it('runs a labelled fixture without network and writes its report', () => {
    const output = join(directory, 'fixture-run');
    const result = cli(['--op', 'fixture', '--plan', planPath, '--output', output]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('NETWORK_FORBIDDEN');
    expect(JSON.parse(result.stdout)).toMatchObject({
      succeeded: 1,
      failed: 0,
      modelKinds: ['fixture'],
      modelCalls: 1,
    });
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
    expect(report.summary.modelKinds).toEqual(['fixture']);
    expect(report.rows[0].decision.modelKind).toBe('fixture');
    expect(readFileSync(join(output, 'plan.json'), 'utf8')).toContain(frozenPlan().planHash);
  });

  it('returns nonzero and preserves an existing output directory', () => {
    const output = join(directory, 'existing');
    mkdirSync(output);
    writeFileSync(join(output, 'report.json'), 'prior-report');
    const result = cli(['--op', 'fixture', '--plan', planPath, '--output', output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EEXIST');
    expect(result.stderr).not.toContain('NETWORK_FORBIDDEN');
    expect(readFileSync(join(output, 'report.json'), 'utf8')).toBe('prior-report');
  });

  it('returns nonzero for corrupt fixture input without creating output', () => {
    writeFileSync(planPath, JSON.stringify({ ...frozenPlan(), planHash: '0'.repeat(64) }));
    const output = join(directory, 'invalid-run');
    const result = cli(['--op', 'fixture', '--plan', planPath, '--output', output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('integrity');
    expect(result.stderr).not.toContain('NETWORK_FORBIDDEN');
    expect(existsSync(output)).toBe(false);
  });
});

describe('DuelLoop SDK endpoint compatibility', () => {
  it.each([
    ['https://api.typesafe.ai', 'https://api.typesafe.ai'],
    ['https://api.typesafe.ai/', 'https://api.typesafe.ai'],
    ['https://api.typesafe.ai/v1', 'https://api.typesafe.ai'],
    ['https://api.typesafe.ai/v1///', 'https://api.typesafe.ai'],
    ['https://proxy.example/jev/v1/', 'https://proxy.example/jev'],
    ['https://proxy.example/v1/proxy', 'https://proxy.example/v1/proxy'],
    ['http://127.0.0.1:9123/v1', 'http://127.0.0.1:9123'],
  ])('normalizes %s to %s while preserving proxy paths', (configured, expected) => {
    expect(sdkBaseUrl(configured)).toBe(expected);
    expect(`${sdkBaseUrl(configured)}/v1/systemone`).toBe(`${expected}/v1/systemone`);
  });

  it.each([
    'http://remote.example/v1',
    'https://user:password@proxy.example/v1',
    'https://proxy.example/v1?api_key=fixture',
    'https://proxy.example/v1#fixture',
  ])('rejects unsafe endpoint %s', (configured) => {
    expect(() => sdkBaseUrl(configured)).toThrow('API base URL');
  });
});
