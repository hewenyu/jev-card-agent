import WebSocket from 'ws';
import { z } from 'zod';

const activeGameSchema = z.object({
  playing: z.boolean(),
  table_id: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  seat: z
    .number()
    .int()
    .nullish()
    .transform((value) => value ?? undefined),
  stack_chips: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined),
});
export type ActiveGame = z.infer<typeof activeGameSchema>;
export class OpenPokerClient {
  constructor(readonly options: { apiKey: string; wsUrl?: string; restUrl?: string }) {}
  connect(): WebSocket {
    return new WebSocket(this.options.wsUrl ?? 'wss://openpoker.ai/ws', {
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      handshakeTimeout: 15_000,
      maxPayload: 2 * 1024 * 1024,
    });
  }
  async activeGame(signal?: AbortSignal): Promise<ActiveGame> {
    const response = await fetch(
      `${(this.options.restUrl ?? 'https://api.openpoker.ai').replace(/\/$/, '')}/api/me/active-game`,
      {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`OpenPoker active-game HTTP ${response.status}`);
    const result = activeGameSchema.parse(await response.json());
    if (result.playing && !result.table_id) throw new Error('Active game omitted table_id');
    return result;
  }
  private request(path: string, signal: AbortSignal, method = 'GET'): Promise<Response> {
    return fetch(
      `${(this.options.restUrl ?? 'https://api.openpoker.ai').replace(/\/$/, '')}/api/${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
  }
  async seasonBalance(signal: AbortSignal): Promise<SeasonBalance | null> {
    const response = await this.request('season/me', signal);
    if (response.status === 404) return null; // First join registers the current season.
    if (!response.ok) throw new Error(`OpenPoker season/me HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (value === null) return null;
    const parsed = z
      .object({
        chip_balance: z.number().int().nonnegative(),
        chips_at_table: z.number().int().nonnegative(),
        pro_tier: z.boolean().optional(),
        auto_rebuy: z.boolean().optional(),
      })
      .parse(value);
    return {
      chipBalance: parsed.chip_balance,
      chipsAtTable: parsed.chips_at_table,
      pro: parsed.pro_tier ?? false,
      autoRebuy: parsed.auto_rebuy ?? false,
    };
  }
  async rebuy(signal: AbortSignal): Promise<RebuyResult> {
    const response = await this.request('season/rebuy', signal, 'POST');
    await response.body?.cancel();
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry === null ? NaN : Number(retry);
      const date = retry === null ? NaN : Date.parse(retry);
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Number.isFinite(date)
          ? date - Date.now()
          : NaN;
      return {
        status: 'cooldown',
        ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(1000, delay) } : {}),
      };
    }
    if (response.status === 400 || response.status === 409) return { status: 'not_eligible' };
    if (!response.ok)
      throw new Error(
        `OpenPoker rebuy HTTP ${response.status}${response.status === 403 ? ': verify account email and rebuy eligibility' : ''}`,
      );
    return { status: 'confirmed' }; // Caller reloads authoritative balances instead of adding chips locally.
  }
}

export interface SeasonBalance {
  chipBalance: number;
  chipsAtTable: number;
  pro: boolean;
  autoRebuy: boolean;
}
export type RebuyResult = {
  status: 'confirmed' | 'not_eligible' | 'cooldown';
  retryAfterMs?: number;
};
