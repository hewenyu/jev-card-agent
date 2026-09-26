import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DuelLoop,
  SqliteStore,
  digest,
  type ModelMaintenanceEvidence,
  type ReleaseBinding,
} from 'duelloop';
import { Store } from '../src/storage/store.js';
import { createPokerStrategy } from '../src/poker/strategy.js';
import { POKER_APPLICATION_ID } from '../src/poker/domain.js';
import { HostJournal } from '../src/duelloop/host/journal.js';
import { DecisionAttempts } from '../src/duelloop/live/attempts.js';
import {
  inspectRetryMaintenanceRaw,
  rebindJevRetry,
  retryMaintenanceModels,
  validateRetryMaintenanceBinding,
  validateRetryMaintenanceReport,
} from '../src/duelloop/host/retry-maintenance.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const suites = [
  'duelloop-model',
  'duelloop-retry',
  'duelloop-live-runtime',
  'duelloop-retry-maintenance',
];
const report = () => ({
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numPassedTests: suites.length,
  testResults: suites.map((name) => ({
    name: `/synthetic-fixture/tests/${name}.test.ts`,
    status: 'passed',
    assertionResults: [
      { status: 'passed', fullName: 'Synthetic input for evidence validation tests' },
    ],
  })),
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jev-retry-maintenance-'));
  directories.push(directory);
  const config = {
    databasePath: join(directory, 'raw.sqlite'),
    duelloopDatabasePath: join(directory, 'sdk.sqlite'),
    duelloopScopeId: 'maintenance-scope',
    duelloopResearch: {
      jev: {
        apiKey: 'synthetic-private-key',
        baseUrl: 'https://api.typesafe.ai',
        model: 'jev-1.13.0',
        timeoutMs: 10000,
      },
      decisionPolicy: { maxDecisionMs: 40000, executionReserveMs: 1500 },
    },
  };
  const models = retryMaintenanceModels(config);
  const sdk = new SqliteStore(config.duelloopDatabasePath);
  const runtime = new DuelLoop({
    applicationId: POKER_APPLICATION_ID,
    domain: models.domain,
    model: models.previous,
    store: sdk,
    mode: 'live',
    executionOwner: 'host',
    ...config.duelloopResearch.decisionPolicy,
  });
  const expectedRelease = runtime.bootstrap(createPokerStrategy(), config.duelloopScopeId);
  const identity = {
    strategyScopeId: config.duelloopScopeId,
    streamId: 'old-stream',
    actorId: 'hero',
    trajectoryId: 'finished-old-hand',
  };
  runtime.pinTrajectory(identity);
  const raw = new Store(config.databasePath);
  new HostJournal(raw.db);
  new DecisionAttempts(raw.db, sdk);
  raw.db.exec(`CREATE TABLE framework_calls (
    request_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, started TEXT NOT NULL,
    result TEXT, late_result TEXT, context_id TEXT);`);
  raw.saveDecisionBlock({
    runId: 'failed-run',
    decisionId: 'failed-decision',
    reason: 'MODEL_INVALID',
    createdAt: '2026-09-26T06:35:22Z',
  });
  raw.close();
  await runtime.close();
  sdk.close();
  const evidence = join(directory, 'test-report.json');
  writeFileSync(evidence, JSON.stringify(report()));
  return { directory, config, models, expectedRelease, evidence, identity };
}

describe('explicit Jev HTTP 403 bootstrap maintenance', () => {
  it('reconstructs the frozen v2.0.3 behavior and changes only its retry policy digest', async () => {
    const f = await fixture();
    expect(f.models.previousDependencies.modelBehaviorDigest).toBe(
      '0f4c58a300b6a4c75f6eecbcb238c4485cc18ec276dc7a96143c80076b9d5442',
    );
    expect(f.models.newDependencies.modelBehaviorDigest).not.toBe(
      f.models.previousDependencies.modelBehaviorDigest,
    );
    expect({ ...f.models.newDependencies, modelBehaviorDigest: '' }).toEqual({
      ...f.models.previousDependencies,
      modelBehaviorDigest: '',
    });
    const alternateKey = structuredClone(f.config);
    alternateKey.duelloopResearch.jev.apiKey = 'a-different-secret';
    expect(retryMaintenanceModels(alternateKey).previousDependencies).toEqual(
      f.models.previousDependencies,
    );
  });

  it('dry-runs without writes, model/Arena requests, or clearing the original decision block', async () => {
    const f = await fixture();
    const fetch = vi.fn(() => {
      throw new Error('Maintenance must not use network');
    });
    vi.stubGlobal('fetch', fetch);
    const before = [hash(f.config.databasePath), hash(f.config.duelloopDatabasePath)];
    const result = await rebindJevRetry(f);
    expect(result.status).toBe('dry-run');
    expect(result.raw.decisionBlockDigest).not.toBeNull();
    expect([hash(f.config.databasePath), hash(f.config.duelloopDatabasePath)]).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    const sdk = new DatabaseSync(f.config.duelloopDatabasePath, { readOnly: true });
    try {
      expect(
        sdk
          .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind='model_maintenance_evidence'")
          .get()?.n,
      ).toBe(0);
    } finally {
      sdk.close();
    }
  });

  it('applies through the SDK, preserves strategy and old pins, and records the exact private report', async () => {
    const f = await fixture();
    const fetch = vi.fn(() => {
      throw new Error('Maintenance must not use network');
    });
    vi.stubGlobal('fetch', fetch);
    const rawHash = hash(f.config.databasePath);
    const oldBlock = inspectRetryMaintenanceRaw(f.config.databasePath).decisionBlockDigest;
    const result = await rebindJevRetry({ ...f, apply: true });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('Expected applied result');
    expect(result.releaseDigest).not.toBe(f.expectedRelease);
    const sdk = new SqliteStore(f.config.duelloopDatabasePath);
    try {
      const binding = sdk.release(result.releaseDigest);
      expect(binding).toMatchObject({
        source: 'maintenance',
        strategyDigest: f.models.strategyDigest,
        previousReleaseDigest: f.expectedRelease,
        dependencies: f.models.newDependencies,
      });
      expect(sdk.activeRelease(f.config.duelloopScopeId)).toBe(result.releaseDigest);
      expect(
        sdk.lookupTrajectoryRelease(
          f.identity.strategyScopeId,
          f.identity.streamId,
          f.identity.actorId,
          f.identity.trajectoryId,
        ),
      ).toBe(f.expectedRelease);
      expect(sdk.release(f.expectedRelease).dependencies).toEqual(f.models.previousDependencies);
      const evidence = sdk.getArtifact<ModelMaintenanceEvidence>(result.evidenceDigest, {
        allowPrivate: true,
      });
      expect(evidence.checks[0]?.artifactDigest).toBe(result.reportDigest);
      expect(
        sdk.getArtifact<{ reportText: string }>(result.reportDigest, { allowPrivate: true })
          .reportText,
      ).toBe(readFileSync(f.evidence, 'utf8'));
      expect(() => sdk.getArtifact(result.reportDigest)).toThrow();
      sdk.assertReleaseEligible(result.releaseDigest, f.models.newDependencies);
    } finally {
      sdk.close();
    }
    expect(hash(f.config.databasePath)).toBe(rawHash);
    expect(inspectRetryMaintenanceRaw(f.config.databasePath).decisionBlockDigest).toBe(oldBlock);
    expect(fetch).not.toHaveBeenCalled();
    await expect(rebindJevRetry({ ...f, apply: true })).rejects.toThrow('no longer active');
  });

  it('rejects a different active release or any non-bootstrap/changed strategy binding', async () => {
    const f = await fixture();
    await expect(rebindJevRetry({ ...f, expectedRelease: '0'.repeat(64) })).rejects.toThrow(
      'no longer active',
    );
    const base: ReleaseBinding = {
      source: 'bootstrap',
      strategyDigest: f.models.strategyDigest,
      dependencies: f.models.previousDependencies,
      scopeId: f.config.duelloopScopeId,
      expectedActiveDigest: null,
      validationDigest: null,
    };
    for (const change of [
      { source: 'research' },
      { strategyDigest: 'wrong' },
      { expectedActiveDigest: 'wrong' },
      { validationDigest: 'wrong' },
    ])
      expect(() =>
        validateRetryMaintenanceBinding(
          { ...base, ...change } as ReleaseBinding,
          f.config.duelloopScopeId,
          f.models,
        ),
      ).toThrow('bootstrap');
    for (const key of Object.keys(base.dependencies)) {
      const altered = structuredClone(base);
      Object.assign(altered.dependencies, { [key]: 'changed' });
      expect(() =>
        validateRetryMaintenanceBinding(altered, f.config.duelloopScopeId, f.models),
      ).toThrow('every reconstructed');
    }
  });

  it('refuses endpoint, model, timeout, or decision-budget drift from the old release', async () => {
    const f = await fixture();
    for (const mutate of [
      (c: typeof f.config) => {
        c.duelloopResearch.jev.baseUrl = 'https://different.example';
      },
      (c: typeof f.config) => {
        c.duelloopResearch.jev.model = 'different-model';
      },
      (c: typeof f.config) => {
        c.duelloopResearch.jev.timeoutMs = 10001;
      },
      (c: typeof f.config) => {
        c.duelloopResearch.decisionPolicy.maxDecisionMs = 40001;
      },
      (c: typeof f.config) => {
        c.duelloopResearch.decisionPolicy.executionReserveMs = 1501;
      },
    ]) {
      const config = structuredClone(f.config);
      mutate(config);
      await expect(rebindJevRetry({ ...f, config })).rejects.toThrow('every reconstructed');
    }
  });

  it.each([
    "INSERT INTO runs(id,mode,strategy,model,status,started_at,config) VALUES('r','live','jev','jev','running','now','{}')",
    "INSERT INTO leases VALUES('runtime','writer',9999999999999)",
    "INSERT INTO runs(id,mode,strategy,model,status,started_at,config) VALUES('r','live','jev','jev','stopped','now','{}'); INSERT INTO actions(id,run_id,decision_id,table_id,payload,status,created_at,deadline_at) VALUES('a','r','d','t','{}','unresolved','now',1)",
    "INSERT INTO framework_attempts(id,context_id,after_event_id,run_id,status) VALUES('attempt','context',0,'run','running')",
    "INSERT INTO framework_outbox(event_key,kind,payload,digest) VALUES('receipt','receipt','{}','digest')",
    "INSERT INTO usage(id,run_id,reserved_nanos,status,created_at) VALUES('u','r',0,'reserved','now'); INSERT INTO framework_calls(request_id,reservation_id,started) VALUES('c','u','{}')",
  ])('refuses an undrained raw runtime before opening the SDK for writes: %s', async (sql) => {
    const f = await fixture();
    const db = new DatabaseSync(f.config.databasePath);
    db.exec(sql);
    db.close();
    const sdkHash = hash(f.config.duelloopDatabasePath);
    const rawHash = hash(f.config.databasePath);
    await expect(rebindJevRetry({ ...f, apply: true })).rejects.toThrow(
      'Raw runtime must be stopped',
    );
    expect(hash(f.config.duelloopDatabasePath)).toBe(sdkHash);
    expect(hash(f.config.databasePath)).toBe(rawHash);
  });

  it('requires all relevant suites to pass in the original Vitest report', async () => {
    expect(() => validateRetryMaintenanceReport(report())).not.toThrow();
    for (const invalid of [
      { ...report(), success: false },
      { ...report(), numFailedTests: 1 },
      { ...report(), testResults: report().testResults.slice(1) },
      {
        ...report(),
        testResults: report().testResults.map((suite) => ({
          ...suite,
          assertionResults: [{ status: 'skipped' }],
        })),
      },
      { passed: true },
    ])
      expect(() => validateRetryMaintenanceReport(invalid)).toThrow();
    const f = await fixture();
    writeFileSync(f.evidence, JSON.stringify({ passed: true }));
    const before = hash(f.config.duelloopDatabasePath);
    await expect(rebindJevRetry({ ...f, apply: true })).rejects.toThrow('Vitest JSON');
    expect(hash(f.config.duelloopDatabasePath)).toBe(before);
  });

  it.each([
    "INSERT INTO runs(id,scope_id,status,revision,data) VALUES('research','maintenance-scope','created',0,'{}')",
    "INSERT INTO intents(decision_id,scope_id,stream_id,idem,data,status) VALUES('intent','maintenance-scope','stream','idem','{}','unknown')",
    "INSERT INTO owners(scope_id,stream_id,owner_id,token,pid,host) VALUES('maintenance-scope','stream','owner','token',1,'maintenance-fixture-other-host')",
  ])(
    'rejects SDK research, unresolved execution or an indeterminate owner without writes: %s',
    async (sql) => {
      const f = await fixture();
      const db = new DatabaseSync(f.config.duelloopDatabasePath);
      db.exec(sql);
      db.close();
      const before = [hash(f.config.databasePath), hash(f.config.duelloopDatabasePath)];
      await expect(rebindJevRetry({ ...f, apply: true })).rejects.toThrow(/SDK/);
      expect([hash(f.config.databasePath), hash(f.config.duelloopDatabasePath)]).toEqual(before);
    },
  );

  it('refuses shared physical database files', async () => {
    const f = await fixture();
    const config = { ...f.config, duelloopDatabasePath: f.config.databasePath };
    await expect(rebindJevRetry({ ...f, config, apply: true })).rejects.toThrow('distinct files');
    expect(digest(f.models.previousDependencies)).not.toBe(digest(f.models.newDependencies));
  });
});
