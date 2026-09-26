import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DuelLoop,
  SqliteStore,
  behaviorDependencies,
  compileStrategy,
  digest,
  type DecisionModel,
  type ModelMaintenanceEvidence,
  type ReleaseBinding,
} from 'duelloop';
import type { AppConfig } from '../../server/config.js';
import { createPokerDomain, POKER_APPLICATION_ID } from '../../poker/domain.js';
import { createPokerStrategy } from '../../poker/strategy.js';
import { sdkBaseUrl } from '../config.js';
import { createLiveModel } from '../live/model.js';
import { RETRY_POLICY } from '../retry.js';
import { createReplayJevModel } from '../transport.js';

type Config = Pick<AppConfig, 'databasePath' | 'duelloopDatabasePath' | 'duelloopScopeId'> & {
  duelloopResearch: Pick<AppConfig['duelloopResearch'], 'jev' | 'decisionPolicy'>;
};
const PREVIOUS_RETRY_POLICY = Object.freeze({
  baseDelayMs: 100,
  multiplier: 2,
  additiveJitterRatio: 0.25,
  retryAfter: 'minimum-delay',
  malformedAnswer: 'immediate-bounded-retry',
});
const REQUIRED_SUITES = [
  'duelloop-model.test.ts',
  'duelloop-retry.test.ts',
  'duelloop-live-runtime.test.ts',
  'duelloop-retry-maintenance.test.ts',
];
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const forbidden = async (): Promise<never> => {
  throw new Error('Maintenance cannot observe Arena or request model decisions');
};

/** Reconstruct v2.0.3 exactly; never derive its old identity by trusting the release. */
export function retryMaintenanceModels(config: Config) {
  requireCondition(
    digest(RETRY_POLICY) === digest({ ...PREVIOUS_RETRY_POLICY, jevHttp403MaxAttempts: 3 }),
    'Maintenance permits only the specified HTTP 403 retry policy addition',
  );
  const options = config.duelloopResearch.jev;
  const inner = createReplayJevModel({
    apiKey: options.apiKey,
    baseURL: sdkBaseUrl(options.baseUrl),
    model: options.model,
    timeoutMs: options.timeoutMs,
  });
  const previous: DecisionModel = {
    id: inner.id,
    kind: inner.kind,
    behaviorIdentity: {
      ...inner.behaviorIdentity,
      adapterVersion: `poker-audited-score-v3/${inner.behaviorIdentity.adapterVersion}`,
      configurationDigest: digest({
        inner: inner.behaviorIdentity,
        maxRetries: 3,
        sharedDeadline: true,
        wallclockDeadlineGuard: 'frozen-before-provider-v1',
        retryPolicy: PREVIOUS_RETRY_POLICY,
        accountingVersion: 'cancelled-unknown-with-separate-late-usage-v3',
      }),
    },
    score: forbidden,
  };
  const model = createLiveModel(options, { onAttempt() {} });
  requireCondition(
    digest(model.behaviorIdentity) ===
      digest({
        ...previous.behaviorIdentity,
        configurationDigest: digest({
          inner: inner.behaviorIdentity,
          maxRetries: 3,
          sharedDeadline: true,
          wallclockDeadlineGuard: 'frozen-before-provider-v1',
          retryPolicy: { ...PREVIOUS_RETRY_POLICY, jevHttp403MaxAttempts: 3 },
          accountingVersion: 'cancelled-unknown-with-separate-late-usage-v3',
        }),
      }),
    'Current live model changed beyond the approved HTTP 403 retry addition',
  );
  const domain = createPokerDomain({ observe: forbidden, candidates: forbidden });
  const policy = config.duelloopResearch.decisionPolicy;
  const previousDependencies = behaviorDependencies(domain, previous, policy);
  const newDependencies = behaviorDependencies(domain, model, policy);
  const { modelBehaviorDigest: before, ...oldRest } = previousDependencies;
  const { modelBehaviorDigest: after, ...newRest } = newDependencies;
  requireCondition(
    before !== after && digest(oldRest) === digest(newRest),
    'Maintenance must change only the model behavior digest',
  );
  return {
    previous,
    model,
    domain,
    previousDependencies,
    newDependencies,
    strategyDigest: digest(compileStrategy(createPokerStrategy(), domain).strategy),
  };
}

/** A real Vitest JSON report is retained as evidence, not converted into research validation. */
export function validateRetryMaintenanceReport(value: unknown): void {
  const report = value as {
    success?: boolean;
    numFailedTests?: number;
    numFailedTestSuites?: number;
    numPassedTests?: number;
    testResults?: Array<{
      name?: string;
      status?: string;
      assertionResults?: Array<{ status?: string }>;
    }>;
  };
  requireCondition(
    report &&
      report.success === true &&
      report.numFailedTests === 0 &&
      report.numFailedTestSuites === 0 &&
      Number(report.numPassedTests) > 0 &&
      Array.isArray(report.testResults),
    'Evidence must be a successful Vitest JSON report',
  );
  for (const name of REQUIRED_SUITES) {
    const suite = report.testResults.find((item) => item.name?.endsWith('/' + name));
    requireCondition(
      suite?.status === 'passed' &&
        suite.assertionResults?.length &&
        suite.assertionResults.every((item) => item.status === 'passed'),
      'Evidence is missing a fully passing required retry maintenance suite',
    );
  }
}

/** Read-only host checks: never initialize Store/HostJournal or clear the decision block. */
export function inspectRetryMaintenanceRaw(path: string, now = Date.now()) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const count = (sql: string) => Number(db.prepare(sql).get()!.n);
    const runningRuns = count("SELECT COUNT(*) AS n FROM runs WHERE status='running'");
    const leases = Number(
      db.prepare("SELECT COUNT(*) AS n FROM leases WHERE name='runtime' AND expires_at>?").get(now)!
        .n,
    );
    const pendingActions = count(
      "SELECT COUNT(*) AS n FROM actions WHERE status IN ('prepared','sent','unresolved')",
    );
    const runningAttempts = count(
      "SELECT COUNT(*) AS n FROM framework_attempts WHERE status='running'",
    );
    const pendingReceipts = count(
      "SELECT COUNT(*) AS n FROM framework_outbox WHERE kind='receipt' AND delivered=0",
    );
    const reservedCalls = count(
      "SELECT COUNT(*) AS n FROM framework_calls c JOIN usage u ON u.id=c.reservation_id WHERE c.result IS NULL AND u.status='reserved'",
    );
    requireCondition(
      [runningRuns, leases, pendingActions, runningAttempts, pendingReceipts, reservedCalls].every(
        (value) => value === 0,
      ),
      'Raw runtime must be stopped with no active lease, attempt, action or receipt',
    );
    const decisionBlock = db
      .prepare("SELECT value FROM meta WHERE key='decision_block'")
      .get()?.value;
    return {
      runningRuns,
      validRuntimeLeases: leases,
      pendingActions,
      runningAttempts,
      pendingReceipts,
      reservedCalls,
      decisionBlockDigest: decisionBlock === undefined ? null : digest(String(decisionBlock)),
    };
  } finally {
    db.close();
  }
}

function inspectRelease(path: string, scopeId: string, expected: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    requireCondition(
      db.prepare('SELECT active FROM scopes WHERE id=?').get(scopeId)?.active === expected,
      'Expected release is no longer active',
    );
    requireCondition(
      db.prepare('SELECT application_id FROM scope_owners WHERE scope_id=?').get(scopeId)
        ?.application_id === POKER_APPLICATION_ID,
      'Maintenance scope belongs to a different application',
    );
    const row = db.prepare('SELECT data FROM releases WHERE digest=?').get(expected);
    requireCondition(row, 'Expected release is missing');
    const binding = JSON.parse(String(row.data)) as ReleaseBinding;
    requireCondition(digest(binding) === expected, 'Release digest does not match its contents');
    const strategy = db
      .prepare('SELECT kind,data FROM artifacts WHERE digest=?')
      .get(binding.strategyDigest);
    requireCondition(
      strategy?.kind === 'strategy' &&
        digest(JSON.parse(String(strategy.data))) === binding.strategyDigest,
      'Original strategy artifact is missing or changed',
    );
    const activeRun = db
      .prepare(
        "SELECT 1 FROM runs WHERE scope_id=? AND status IN ('created','researching','development_evaluating','candidate_locked','final_evaluating','validated_pending_release','cancel_requested') LIMIT 1",
      )
      .get(scopeId);
    const intent = db
      .prepare(
        "SELECT 1 FROM intents WHERE scope_id=? AND status IN ('pending','accepted','unknown') LIMIT 1",
      )
      .get(scopeId);
    requireCondition(!activeRun && !intent, 'SDK research or execution must be drained');
    for (const owner of db.prepare('SELECT pid,host FROM owners WHERE scope_id=?').all(scopeId)) {
      let alive = true;
      if (owner.host === hostname()) {
        try {
          process.kill(Number(owner.pid), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
      }
      requireCondition(!alive, 'SDK execution owner must be closed before maintenance');
    }
    return binding;
  } finally {
    db.close();
  }
}

export function validateRetryMaintenanceBinding(
  binding: ReleaseBinding,
  scopeId: string,
  models: ReturnType<typeof retryMaintenanceModels>,
): void {
  requireCondition(
    binding.source === 'bootstrap' &&
      binding.scopeId === scopeId &&
      binding.validationDigest === null &&
      binding.expectedActiveDigest === null &&
      binding.researchRunId === undefined &&
      binding.previousReleaseDigest === undefined &&
      binding.evidenceDigest === undefined &&
      binding.strategyDigest === models.strategyDigest,
    'Maintenance requires the unchanged application bootstrap strategy',
  );
  requireCondition(
    digest(binding.dependencies) === digest(models.previousDependencies),
    'Old release must match every reconstructed v2.0.3 dependency',
  );
}

/** Run in an isolated maintenance container only after stopping all application writers. */
export async function rebindJevRetry(options: {
  config: Config;
  expectedRelease: string;
  evidence: string;
  apply?: boolean;
}) {
  requireCondition(
    /^[0-9a-f]{64}$/.test(options.expectedRelease),
    '--expected-release must be a release SHA256',
  );
  const config = options.config;
  const rawPath = realpathSync(resolve(config.databasePath));
  const sdkPath = realpathSync(resolve(config.duelloopDatabasePath));
  const rawStat = statSync(rawPath);
  const sdkStat = statSync(sdkPath);
  requireCondition(
    rawStat.isFile() &&
      sdkStat.isFile() &&
      (rawStat.dev !== sdkStat.dev || rawStat.ino !== sdkStat.ino),
    'Raw and SDK databases must be existing distinct files',
  );
  const raw = inspectRetryMaintenanceRaw(rawPath);
  const text = readFileSync(options.evidence, 'utf8');
  const report: unknown = JSON.parse(text);
  validateRetryMaintenanceReport(report);
  const models = retryMaintenanceModels(config);
  const binding = inspectRelease(sdkPath, config.duelloopScopeId, options.expectedRelease);
  validateRetryMaintenanceBinding(binding, config.duelloopScopeId, models);
  const summary = {
    scopeId: config.duelloopScopeId,
    previousReleaseDigest: options.expectedRelease,
    strategyDigest: binding.strategyDigest,
    previousDependencies: models.previousDependencies,
    newDependencies: models.newDependencies,
    testReportSha256: createHash('sha256').update(text).digest('hex'),
    raw,
  };
  if (!options.apply) return { status: 'dry-run' as const, ...summary };
  requireCondition(
    digest(inspectRetryMaintenanceRaw(rawPath)) === digest(raw),
    'Raw runtime state changed before maintenance',
  );
  const store = new SqliteStore(sdkPath);
  const runtime = new DuelLoop({
    applicationId: POKER_APPLICATION_ID,
    domain: models.domain,
    model: models.model,
    store,
    mode: 'live',
    executionOwner: 'host',
    ...config.duelloopResearch.decisionPolicy,
  });
  try {
    requireCondition(
      store.activeRelease(config.duelloopScopeId) === options.expectedRelease,
      'Active release changed before maintenance',
    );
    validateRetryMaintenanceBinding(
      store.release(options.expectedRelease),
      config.duelloopScopeId,
      models,
    );
    const reportDigest = store.putArtifact(
      'maintenance_check_report',
      {
        schemaVersion: 'jev-403-retry-vitest-report-v1',
        sha256: summary.testReportSha256,
        reportText: text,
      },
      'private',
    );
    const evidence: ModelMaintenanceEvidence = {
      schemaVersion: '1.0',
      kind: 'bootstrap_model_maintenance',
      scopeId: config.duelloopScopeId,
      previousReleaseDigest: options.expectedRelease,
      strategyDigest: binding.strategyDigest,
      previousDependencies: models.previousDependencies,
      newDependencies: runtime.dependencies,
      reason:
        'v2.0.4: Jev HTTP 403 retries share the existing deadline and stop after three attempts; bootstrap strategy unchanged',
      createdAt: Date.now(),
      checks: [
        {
          name: 'Jev HTTP 403 retries and maintenance regression tests',
          passed: true,
          artifactDigest: reportDigest,
        },
      ],
    };
    const evidenceDigest = store.putArtifact('model_maintenance_evidence', evidence, 'private');
    await runtime.stop();
    const releaseDigest = await runtime.rebindBootstrapModel(config.duelloopScopeId, {
      expectedReleaseDigest: options.expectedRelease,
      evidenceDigest,
    });
    requireCondition(
      digest(inspectRetryMaintenanceRaw(rawPath)) === digest(raw),
      'Raw runtime changed during maintenance; inspect before resuming',
    );
    return { status: 'applied' as const, ...summary, releaseDigest, evidenceDigest, reportDigest };
  } finally {
    try {
      await runtime.close();
    } finally {
      store.close();
    }
  }
}
