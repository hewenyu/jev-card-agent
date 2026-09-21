// Run from the application root after draining/stopping the bot; never starts a runtime.
// Example: DATA_DIR=/app/data node scripts/rebuild-opponents.mjs
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const databasePath = resolve(
  process.env.DATABASE_PATH || resolve(process.env.DATA_DIR || 'data', 'jev.sqlite'),
);
if (!existsSync(databasePath)) throw new Error('The configured database does not exist');
const { Store } = await import(pathToFileURL(resolve('dist/storage/store.js')).href);
const { rebuildOpponentCheckpoint } = await import(
  pathToFileURL(resolve('dist/storage/opponent-rebuild.js')).href
);
const store = new Store(databasePath);
try {
  process.stdout.write(`${JSON.stringify(rebuildOpponentCheckpoint(store), null, 2)}\n`);
} finally {
  store.close();
}
