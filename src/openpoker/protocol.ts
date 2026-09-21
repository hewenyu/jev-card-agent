import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseWireJson, serializeWireJson, transferNumberSources } from './wire-json.js';

/** Unknown additive server fields survive validation for forward compatibility. */
const envelope = z
  .object({
    type: z.string().min(1),
    table_id: z.string().nullable().optional(),
    hand_id: z.string().nullable().optional(),
    table_seq: z.number().int().nonnegative().nullable().optional(),
    hand_seq: z.number().int().nonnegative().nullable().optional(),
    ts: z.string().nullable().optional(),
  })
  .passthrough();
export type ServerEvent = z.infer<typeof envelope>;
export type ActionPayload = {
  type: 'action';
  action: string;
  amount?: number;
  hand_id: string;
  turn_token: string;
  client_action_id: string;
};
export function parseEvent(raw: string): ServerEvent {
  const decoded = parseWireJson(raw);
  const event = envelope.parse(decoded);
  transferNumberSources(decoded as object, event);
  return event;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
/** Persist the received numeric representation as well as the business values. */
export function serializeEvent(event: ServerEvent): string {
  return serializeWireJson(event);
}
export function verifyStateHash(event: ServerEvent): boolean {
  if (typeof event.state_hash !== 'string') return true;
  const excluded = new Set(['ts', 'table_seq', 'hand_seq', 'state_hash']);
  const digest = createHash('sha256').update(serializeWireJson(event, excluded)).digest('hex');
  return event.state_hash === `sha256:${digest}`;
}
