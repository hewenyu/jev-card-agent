import { createHash } from 'node:crypto';
import { z } from 'zod';

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
  return envelope.parse(JSON.parse(raw));
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
/** OpenPoker canonical JSON is Python ensure_ascii=true, recursively sorted keys. */
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => record(value)[key] !== undefined)
      .sort()
      .map((key) => `${canonical(key)}:${canonical(record(value)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
export function verifyStateHash(event: ServerEvent): boolean {
  if (typeof event.state_hash !== 'string') return true;
  const excluded = new Set(['ts', 'table_seq', 'hand_seq', 'state_hash']);
  const body = Object.fromEntries(Object.entries(event).filter(([key]) => !excluded.has(key)));
  const digest = createHash('sha256').update(canonical(body)).digest('hex');
  return event.state_hash === `sha256:${digest}`;
}
