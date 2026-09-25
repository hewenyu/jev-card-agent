import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statfsSync,
  createReadStream,
  createWriteStream,
  unlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { DatabaseSync, backup } from 'node:sqlite';

const directory = process.env.BACKUP_DIRECTORY || '/app/data/backups';
const reserveBytes = 1024n * 1024n * 1024n;
function checkSpace(bytes) {
  const space = statfsSync(directory, { bigint: true });
  if (space.bavail * space.bsize < bytes + reserveBytes)
    throw new Error(
      'Insufficient backup space; runtime and research remain stopped. Free space before retrying.',
    );
}
async function hashFile(path, decompress = false) {
  const hash = createHash('sha256');
  const sink = new Writable({
    write(chunk, encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  if (decompress) await pipeline(createReadStream(path), createGunzip(), sink);
  else await pipeline(createReadStream(path), sink);
  return hash.digest('hex');
}
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
const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
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
    const pages = BigInt(db.prepare('PRAGMA page_count').get().page_count);
    const pageSize = BigInt(db.prepare('PRAGMA page_size').get().page_size);
    // Snapshot plus pessimistic gzip size, rounded up with framing overhead.
    checkSpace((pages * pageSize * 202n) / 100n + 1024n * 1024n);
    await backup(db, target);
  } finally {
    db.close();
  }
  chmodSync(target, 0o600);
  const copy = new DatabaseSync(target);
  try {
    // Make the standalone snapshot independent of WAL/SHM sidecars before compression.
    copy.exec('PRAGMA journal_mode=DELETE');
    const check = copy.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok')
      throw new Error(`Backup integrity check failed: ${name}`);
  } finally {
    copy.close();
  }
  const digest = await hashFile(target);
  const archive = `${target}.gz`;
  await pipeline(
    createReadStream(target),
    createGzip(),
    createWriteStream(archive, { mode: 0o600, flags: 'wx' }),
  );
  if ((await hashFile(archive, true)) !== digest)
    throw new Error(`Compressed backup integrity check failed: ${name}`);
  unlinkSync(target);
  completed.push(archive);
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
  checkSpace(BigInt(body.length));
  const target = `${directory}/${name}-${stamp}.json`;
  writeFileSync(target, body, { mode: 0o600, flag: 'wx' });
  completed.push(target);
}
process.stderr.write(
  'Runtime and research remain stopped. Operator pause settings are preserved.\n',
);
for (const path of completed) process.stdout.write(`${path}\n`);
