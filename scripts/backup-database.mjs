import { mkdirSync, chmodSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';

const directory = '/app/data/backups';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = `${directory}/jev-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
const db = new DatabaseSync(process.env.DATABASE_PATH || '/app/data/jev.sqlite', {
  readOnly: true,
});
try {
  await backup(db, target);
  chmodSync(target, 0o600);
  process.stdout.write(`${target}\n`);
} finally {
  db.close();
}
