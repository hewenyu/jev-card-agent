import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';

const directory = '/app/data/backups';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = `${directory}/jev-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
const rawPath = process.env.DATABASE_PATH || '/app/data/jev.sqlite';
const knowledgePath = process.env.KNOWLEDGE_DATABASE_PATH || `${rawPath}.knowledge.sqlite`;
const knowledgeTarget = target.replace('/jev-', '/knowledge-');
// Back up derived data first so its cursors never point beyond the subsequent raw snapshot.
// Hand bindings in the raw database contain their full immutable snapshot as well.
const hasKnowledge = existsSync(knowledgePath);
if (hasKnowledge) {
  const knowledge = new DatabaseSync(knowledgePath, { readOnly: true });
  try {
    await backup(knowledge, knowledgeTarget);
    chmodSync(knowledgeTarget, 0o600);
  } finally {
    knowledge.close();
  }
}
const db = new DatabaseSync(rawPath, {
  readOnly: true,
});
try {
  await backup(db, target);
  chmodSync(target, 0o600);
  process.stdout.write(`${target}\n`);
  if (hasKnowledge) process.stdout.write(`${knowledgeTarget}\n`);
} finally {
  db.close();
}
