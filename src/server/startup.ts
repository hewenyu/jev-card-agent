import type { AppConfig } from './config.js';
import type { RunRequest } from './controller.js';
import type { RuntimeView } from '../shared/api.js';

interface StartupApp {
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<unknown>;
  controller: { start(request: RunRequest): Promise<RuntimeView>; canAutoStart?(): boolean };
}

/** Only the server entry point calls this; building an app for tests never starts a bot. */
export async function listenAndStart(app: StartupApp, config: AppConfig): Promise<void> {
  try {
    await app.listen({ host: config.host, port: config.port });
    if (!config.autoStartBot || config.demo || config.readOnlyDemo) return;
    if (app.controller.canAutoStart?.() === false) return;
    const runtime = await app.controller.start({
      strategy: config.botStrategy,
      buyIn: 2000,
      autoRebuy: true,
      maxHands: 0,
      maxMinutes: 0,
    });
    // Runtime.start may resolve after recording a REST startup failure instead of throwing.
    if (!runtime.running || runtime.status === 'failed')
      throw new Error(runtime.error ?? `Runtime is ${runtime.status}`);
  } catch (error) {
    await app.close();
    throw new Error(
      `Server startup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
