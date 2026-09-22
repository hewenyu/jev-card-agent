import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBatchV2 } from './contracts.js';
export interface ResearchScheduleEntry {
  scopeKey: string;
  taskType: ResearchBatchV2['taskType'];
  windowHands: number;
  newHands: number;
  requiredHands: number;
  stage: 'initial' | 'refresh';
  reason: string;
  state: 'waiting' | 'pending' | 'running';
  lastCompletedAt: string | null;
  lastAttemptAt: string | null;
  lastOutcome: 'completed' | 'insufficient' | 'failed' | 'cancelled' | null;
  updatedAt: string;
  triggerKind?: NonNullable<ResearchBatchV2['triggers']>[number]['kind'];
}
export interface ScheduleEvaluation {
  entry: ResearchScheduleEntry;
  eligible: boolean;
  priority: number;
}
export function triggerKey(trigger: NonNullable<ResearchBatchV2['triggers']>[number]): string {
  // Decision attribution can be enriched later; the server event remains the same trigger.
  return `${trigger.kind}:${trigger.handId}:${trigger.eventId}`;
}
/** A replacement cannot silently consume an unresearched salient case by dropping its evidence. */
export function preservesPendingTriggers(
  previous: ResearchBatchV2,
  next: ResearchBatchV2,
): boolean {
  const nextTriggers = new Set((next.triggers ?? []).map(triggerKey));
  return (previous.triggers ?? []).every(
    (trigger) =>
      nextTriggers.has(triggerKey(trigger)) &&
      next.examples.some(
        (example) => example.handId === trigger.handId && example.phase === 'post_settlement',
      ) &&
      (!trigger.decisionId ||
        next.examples.some((example) => example.id === `decision-${trigger.decisionId}`)) &&
      previous.examples
        .filter(
          (example) => example.handId === trigger.handId && example.phase === 'decision_visible',
        )
        .every((example) => next.examples.some((candidate) => candidate.id === example.id)),
  );
}
/** Derived status only; frozen jobs remain the authoritative scheduling/deduplication evidence. */
export class ResearchScheduler {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS research_schedules (
      task_type TEXT NOT NULL, scope_key TEXT NOT NULL, snapshot TEXT NOT NULL,
      PRIMARY KEY(task_type,scope_key));`);
  }
  evaluate(
    batch: ResearchBatchV2,
    minimum: number,
    initialMinimum = minimum,
    now = new Date().toISOString(),
  ): ScheduleEvaluation {
    const latest = this.db
      .prepare(
        'SELECT batch,state,outcome,completed_at FROM research_jobs WHERE task_type=? AND scope_key=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(batch.taskType, batch.scopeKey);
    const previous = latest ? (JSON.parse(String(latest.batch)) as ResearchBatchV2) : null;
    const seen = new Set(previous?.eligibleHandIds ?? []);
    const newHands = batch.eligibleHandIds.filter((id) => !seen.has(id)).length;
    const requiredHands = previous ? minimum : initialMinimum;
    const newer =
      !previous ||
      (batch.evidenceEventWatermark > previous.evidenceEventWatermark &&
        batch.cutoff >= previous.cutoff);
    // Frozen evidence from every earlier job consumes its events even after failure or expiry.
    // Retrying identical evidence after exhausted provider retries would otherwise create a paid busy loop.
    const consumed = new Set<string>();
    if (batch.triggers?.length) {
      for (const row of this.db
        .prepare(
          `SELECT t.value FROM research_jobs j,json_each(j.batch,'$.triggers') t
          WHERE j.task_type=? AND j.scope_key=?`,
        )
        .all(batch.taskType, batch.scopeKey)) {
        consumed.add(
          triggerKey(
            JSON.parse(String(row.value)) as NonNullable<ResearchBatchV2['triggers']>[number],
          ),
        );
      }
    }
    const trigger = (batch.triggers ?? []).find(
      (t) =>
        batch.eligibleHandIds.includes(t.handId) &&
        t.availableAt <= batch.cutoff &&
        t.eventId <= batch.evidenceEventWatermark &&
        !consumed.has(triggerKey(t)) &&
        // Older deployments had no trigger field: do not resubmit all their settled hands on upgrade.
        (!previous ||
          !previous.eligibleHandIds.includes(t.handId) ||
          t.eventId > previous.evidenceEventWatermark),
    );
    const pending = latest?.state === 'pending';
    const eligible = newer && (newHands >= requiredHands || !!trigger || (pending && newHands > 0));
    let reason = previous ? 'refresh_threshold' : 'initial_sample';
    if (!newer) reason = 'unchanged_evidence';
    else if (trigger) reason = 'event_trigger';
    const outcome = latest?.outcome
      ? (JSON.parse(String(latest.outcome)) as { insufficient?: boolean })
      : null;
    if (!eligible && outcome?.insufficient) reason = 'insufficient_waiting_new_evidence';
    if (!eligible && (latest?.state === 'failed' || latest?.state === 'cancelled'))
      reason = 'failed_waiting_new_evidence';
    const entry: ResearchScheduleEntry = {
      scopeKey: batch.scopeKey,
      taskType: batch.taskType,
      windowHands: batch.eligibleHandIds.length,
      newHands,
      requiredHands,
      stage: previous ? 'refresh' : 'initial',
      reason,
      state: 'waiting',
      lastCompletedAt: null,
      lastAttemptAt: null,
      lastOutcome: null,
      updatedAt: now,
      ...(trigger ? { triggerKind: trigger.kind } : {}),
    };
    return { entry, eligible, priority: trigger ? 1 : 0 };
  }
  save(entry: ResearchScheduleEntry): void {
    this.db
      .prepare(
        `INSERT INTO research_schedules(task_type,scope_key,snapshot) VALUES(?,?,?)
      ON CONFLICT(task_type,scope_key) DO UPDATE SET snapshot=excluded.snapshot`,
      )
      .run(entry.taskType, entry.scopeKey, JSON.stringify(entry));
  }
  entries(): ResearchScheduleEntry[] {
    return this.db
      .prepare(
        `SELECT snapshot FROM research_schedules s ORDER BY
        CASE WHEN s.scope_key='global' THEN 0 ELSE 1 END,
        CASE WHEN EXISTS (SELECT 1 FROM research_jobs j WHERE j.task_type=s.task_type AND j.scope_key=s.scope_key AND j.state IN ('running','pending')) THEN 0 ELSE 1 END,
        json_extract(s.snapshot,'$.updatedAt') DESC,s.task_type,s.scope_key LIMIT 64`,
      )
      .all()
      .map((row) => {
        const entry = JSON.parse(String(row.snapshot)) as ResearchScheduleEntry;
        const active = this.db
          .prepare(
            `SELECT state FROM research_jobs WHERE task_type=? AND scope_key=?
        AND state IN ('pending','running') ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END LIMIT 1`,
          )
          .get(entry.taskType, entry.scopeKey);
        const last = this.db
          .prepare(
            `SELECT state,outcome,completed_at FROM research_jobs WHERE task_type=? AND scope_key=?
        AND state IN ('completed','failed','cancelled') ORDER BY rowid DESC LIMIT 1`,
          )
          .get(entry.taskType, entry.scopeKey);
        const outcome = last?.outcome
          ? (JSON.parse(String(last.outcome)) as { insufficient?: boolean })
          : null;
        return {
          ...entry,
          state: active ? (String(active.state) as 'running' | 'pending') : 'waiting',
          lastCompletedAt:
            (this.db
              .prepare(
                `SELECT MAX(completed_at) AS t FROM research_jobs
          WHERE task_type=? AND scope_key=? AND state='completed'`,
              )
              .get(entry.taskType, entry.scopeKey)?.t as string | null) ?? null,
          lastAttemptAt:
            (this.db
              .prepare(
                `SELECT MAX(a.started_at) AS t FROM research_attempts a JOIN research_jobs j ON j.id=a.job_id
          WHERE j.task_type=? AND j.scope_key=?`,
              )
              .get(entry.taskType, entry.scopeKey)?.t as string | null) ?? null,
          lastOutcome: last
            ? outcome?.insufficient
              ? 'insufficient'
              : (String(last.state) as 'completed' | 'failed' | 'cancelled')
            : null,
        };
      });
  }
}
