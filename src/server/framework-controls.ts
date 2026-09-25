import { DuelLoop, SqliteStore, type ScopeStatus } from 'duelloop';
import type { Store } from '../storage/store.js';
import type { AppConfig } from './config.js';
import { createPokerDomain, POKER_APPLICATION_ID } from '../poker/domain.js';
import { createLiveModel } from '../duelloop/live/model.js';
import { createReleaseControls } from '../duelloop/research/releases.js';

export type ReleaseOperation =
  | { type: 'approve' | 'rollback'; releaseDigest: string; actor: string; reason: string }
  | { type: 'pause'; paused: boolean; actor: string; reason: string };

/** Separate control-only SDK handle: no observation, model requests, or execution permissions. */
export class FrameworkControls {
  readonly store: SqliteStore;
  private readonly runtime: DuelLoop;
  private closed = false;
  private cachedStatus?: Pick<
    ScopeStatus,
    'scopeId' | 'activeReleaseDigest' | 'activationMode' | 'activationPaused'
  >;
  constructor(
    private readonly config: AppConfig,
    private readonly raw: Store,
  ) {
    this.store = new SqliteStore(
      raw.filename === ':memory:' ? ':memory:' : config.duelloopDatabasePath,
    );
    this.store.setActivationMode(config.duelloopScopeId, config.duelloopResearch.activationMode);
    const model = createLiveModel(
      {
        apiKey: config.jevApiKey || 'control-plane-no-network',
        baseUrl: config.jevBaseUrl,
        model: config.jevModel,
        timeoutMs: config.jevTimeoutMs,
      },
      {
        onStart: () => {
          throw new Error('Control plane cannot call models');
        },
        onAttempt: () => {
          throw new Error('Control plane cannot call models');
        },
      },
    );
    const domain = createPokerDomain({
      async observe() {
        throw new Error('Control plane has no action authority');
      },
      async candidates() {
        throw new Error('Control plane has no action authority');
      },
    });
    this.runtime = new DuelLoop({
      applicationId: POKER_APPLICATION_ID,
      domain,
      model,
      store: this.store,
      mode: 'simulation',
      executionOwner: 'host',
      ...config.duelloopResearch.decisionPolicy,
    });
    raw.db.exec(`CREATE TABLE IF NOT EXISTS framework_operator_audit(
      id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,
      operation TEXT NOT NULL,status TEXT NOT NULL,error TEXT);`);
  }
  status() {
    if (this.closed) return this.cachedStatus!;
    this.cachedStatus = this.store.scopeSummary(this.config.duelloopScopeId);
    return this.cachedStatus;
  }
  async run(operation: ReleaseOperation): Promise<void> {
    if (!operation.actor.trim() || !operation.reason.trim())
      throw new Error('Operator identity and reason are required');
    const row = this.raw.db
      .prepare(
        'INSERT INTO framework_operator_audit(at,actor,reason,operation,status) VALUES(?,?,?,?,?)',
      )
      .run(
        new Date().toISOString(),
        operation.actor,
        operation.reason,
        JSON.stringify(operation),
        'requested',
      );
    const controls = createReleaseControls(this.runtime, this.store, this.config.duelloopScopeId);
    try {
      if (operation.type === 'approve') await controls.approve(operation.releaseDigest);
      else if (operation.type === 'rollback') await controls.rollback(operation.releaseDigest);
      else if (operation.type === 'pause') controls.pause(operation.paused);
      this.raw.db
        .prepare("UPDATE framework_operator_audit SET status='completed' WHERE id=?")
        .run(row.lastInsertRowid);
    } catch (error) {
      this.raw.db
        .prepare("UPDATE framework_operator_audit SET status='failed',error=? WHERE id=?")
        .run(error instanceof Error ? error.message : 'Failed', row.lastInsertRowid);
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.status();
    this.closed = true;
    await this.runtime.close();
    this.store.close();
  }
}
