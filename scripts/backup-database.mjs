import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';

const directory = '/app/data/backups';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = `${directory}/jev-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
const rawPath = process.env.DATABASE_PATH || '/app/data/jev.sqlite';
const knowledgePath = process.env.KNOWLEDGE_DATABASE_PATH || `${rawPath}.knowledge.sqlite`;
const researchPath = process.env.RESEARCH_DATABASE_PATH || `${rawPath}.research.sqlite`;
const base = `http://127.0.0.1:${process.env.PORT || '8787'}`;
async function workerControl(action) {
  const response = await fetch(`${base}/api/research/${action}`, {
    method: 'POST',
    headers: process.env.API_TOKEN ? { Authorization: `Bearer ${process.env.API_TOKEN}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Research ${action} failed: HTTP ${response.status}`);
}
// Pause both derived writers. Runtime's current pin remains usable; this does not resume a bot.
// For a release backup, drain the hand and confirm official unseated placement first.
await workerControl('pause');
const completed = [];
try {
  // SQLite backup includes committed WAL contents. Never copy a live SQLite main file directly.
  for (const [path, name] of [
    [researchPath, 'research'],
    [knowledgePath, 'knowledge'],
  ]) {
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path, { readOnly: true });
    const destination = target.replace('/jev-', `/${name}-`);
    try {
      await backup(db, destination);
      chmodSync(destination, 0o600);
      completed.push(destination);
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(rawPath, { readOnly: true });
  try {
    await backup(db, target);
    chmodSync(target, 0o600);
    completed.push(target);
  } finally {
    db.close();
  }
} finally {
  await workerControl('restart');
}
for (const path of completed) process.stdout.write(`${path}\n`);
