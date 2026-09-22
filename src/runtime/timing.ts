/** Wall-clock stages for one frozen decision. Knowledge is a subset of preparation. */
export interface DecisionTiming {
  receivedAt: string;
  preparationStartedAt: string;
  preparationMs: number;
  knowledgeMs: number;
  providerMs: number;
  persistenceMs: number;
  firstSentAt?: string;
  lastSentAt?: string;
  sendMs?: number;
  acknowledgedAt?: string;
  ackMs?: number;
  receiptToSendMs?: number;
}

export function markSent(timing: DecisionTiming | undefined, startedAt: number): void {
  if (!timing) return;
  const now = Date.now();
  timing.firstSentAt ??= new Date(now).toISOString();
  timing.lastSentAt = new Date(now).toISOString();
  timing.sendMs = (timing.sendMs ?? 0) + Math.max(0, now - startedAt);
  timing.receiptToSendMs = Math.max(
    0,
    Date.parse(timing.firstSentAt) - Date.parse(timing.receivedAt),
  );
}

export function markAcknowledged(timing: DecisionTiming | undefined): void {
  if (!timing) return;
  timing.acknowledgedAt = new Date().toISOString();
  if (timing.firstSentAt)
    timing.ackMs = Math.max(0, Date.parse(timing.acknowledgedAt) - Date.parse(timing.firstSentAt));
}
