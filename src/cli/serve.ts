import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { listenAndStart } from '../server/startup.js';
import { argumentsFor, fail } from './args.js';

async function main(): Promise<void> {
  const args = argumentsFor({ demo: { type: 'boolean', default: false } });
  const config = loadConfig(process.env, args.demo === true);
  const app = await buildApp(config);
  let closing = false;
  const shutdown = () => {
    if (closing) {
      app.controller.stop(false);
      return;
    }
    closing = true;
    void (async () => {
      const runtime = app.controller.runtime;
      if (runtime && app.controller.view().running) {
        await new Promise<void>((resolve) => {
          runtime.once('stopped', resolve);
          runtime.stop(true);
        });
      }
      await app.close();
    })().catch(fail);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await listenAndStart(app, config);
  if (config.autoStartBot && !config.demo && !config.readOnlyDemo) {
    // A later authentication/reconnect failure must not leave an apparently healthy idle container.
    app.controller.runtime?.once('stopped', (status) => {
      if (status.phase !== 'failed' || closing) return;
      closing = true;
      void app
        .close()
        .then(
          () => fail(new Error(`Autostart runtime failed: ${status.lastError ?? 'Unknown error'}`)),
          fail,
        );
    });
  }
  process.stdout.write(
    `Jev console: http://${config.host}:${config.port}${config.demo ? ' (synthetic demo)' : ''}\n`,
  );
}
void main().catch(fail);
