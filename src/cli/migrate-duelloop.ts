import { parseArgs } from 'node:util';
import { migrateDuelLoop } from '../duelloop/host/migrate.js';

const { values } = parseArgs({
  options: {
    database: { type: 'string' },
    env: { type: 'string', default: '.env' },
    output: { type: 'string' },
  },
});
if (!values.database) throw new Error('--database is required');
try {
  const manifest = await migrateDuelLoop({
    database: values.database,
    env: values.env,
    output: values.output,
  });
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
} catch {
  // Provider keys and arbitrary SQLite content must never be printed through error messages.
  process.stderr.write(
    'Copy-only migration failed; originals were not modified. Inspect the private output and source paths.\n',
  );
  process.exitCode = 1;
}
