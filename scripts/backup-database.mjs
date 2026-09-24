import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';

const directory = '/app/data/backups';
const rawPath = process.env.DATABASE_PATH || '/app/data/jev.sqlite';
const base = `http://127.0.0.1:${process.env.PORT || '8787'}`;
const headers = process.env.API_TOKEN ? { Authorization: `Bearer ${process.env.API_TOKEN}` } : {};
async function request(path, method = 'GET') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Backup preparation failed: HTTP ${response.status}`);
  return response.json();
}
// manage.sh drains first. Refuse a direct invocation while the runtime still has action authority.
const overview = await request('/api/overview');
if (overview.runtime.running) throw new Error('Drain the runtime before backing up');
// Stop worker processes without changing persistent operator pause controls. Deliberately do not
// restart writers: a release backup must remain stable until the replacement is reviewed.
await request('/api/research/pause', 'POST');
const after = await request('/api/overview');
if (after.runtime.running) throw new Error('Runtime restarted during backup preparation');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const completed = [];
for (const [path, name] of [
  [rawPath, 'jev'],
  [process.env.KNOWLEDGE_DATABASE_PATH || `${rawPath}.knowledge.sqlite`, 'knowledge'],
  [process.env.RESEARCH_DATABASE_PATH || `${rawPath}.research.sqlite`, 'research'],
  [process.env.FACTS_DATABASE_PATH || `${rawPath}.facts.sqlite`, 'facts'],
  [process.env.DUELLOOP_DATABASE_PATH || `${rawPath}.duelloop.sqlite`, 'duelloop'],
]) {
  if (!existsSync(path)) {
    if (name === 'jev') throw new Error('Raw database is missing');
    continue;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  const target = `${directory}/${name}-${stamp}.sqlite`;
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  chmodSync(target, 0o600);
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    const check = copy.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok')
      throw new Error(`Backup integrity check failed: ${name}`);
  } finally {
    copy.close();
  }
  completed.push(target);
}
for (const [path, name] of [
  [
    process.env.DUELLOOP_DEVELOPMENT_PROTOCOL || '/app/data/protocols/development.json',
    'protocol-development',
  ],
  [process.env.DUELLOOP_FINAL_PROTOCOL || '/app/data/protocols/final.json', 'protocol-final'],
]) {
  if (!existsSync(path)) continue;
  const body = readFileSync(path);
  JSON.parse(body.toString('utf8'));
  const target = `${directory}/${name}-${stamp}.json`;
  writeFileSync(target, body, { mode: 0o600, flag: 'wx' });
  completed.push(target);
}
process.stderr.write(
  'Runtime and research remain stopped. Operator pause settings are preserved.\n',
);
for (const path of completed) process.stdout.write(`${path}\n`);
