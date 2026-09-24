import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';
import { SqliteStore } from 'duelloop';
import { Store } from '../../storage/store.js';
import { Queries } from '../../storage/queries.js';
import { HostJournal } from './journal.js';
import { encodeMigrationEnv, writeMigrationCompose } from './migration-compose.js';

type Category = 'raw' | 'knowledge' | 'research' | 'facts' | 'sdk';
const retired = /^(ASYNC_LLM_|LLM_ADVICE_|LLM_RESEARCH_)|^(REASONING_MODE|HYBRID_TIMEOUT_MS)$/;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function physical(path: string): string {
  return existsSync(path) ? realpathSync(path) : join(physical(dirname(path)), basename(path));
}
async function hashDatabase(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 }))
    hash.update(chunk);
  return hash.digest('hex');
}
function inspect(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || Object.values(checks[0]!)[0] !== 'ok')
      throw new Error('SQLite quick_check failed');
    const counts: Record<string, number> = {};
    for (const row of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all())
      counts[String(row.name)] = Number(
        db.prepare(`SELECT COUNT(*) AS n FROM ${quote(String(row.name))}`).get()!.n,
      );
    return { quickCheck: 'ok' as const, tables: counts };
  } finally {
    db.close();
  }
}
export interface MigrationOptions {
  database: string;
  env: string;
  output?: string;
}
/** Consistent per-file snapshots; all schema migration and validation runs exclusively on copies. */
export async function migrateDuelLoop(options: MigrationOptions) {
  const envPath = resolve(options.env);
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  const raw = resolve(options.database);
  if (!existsSync(raw) || !statSync(raw).isFile())
    throw new Error('Source raw database must exist');
  const output = resolve(options.output ?? `data/migration/${randomUUID()}`);
  if (existsSync(output)) throw new Error('Migration output must not already exist');
  const sources: Record<Category, string> = {
    raw,
    knowledge: resolve(env.KNOWLEDGE_DATABASE_PATH || `${raw}.knowledge.sqlite`),
    research: resolve(env.RESEARCH_DATABASE_PATH || `${raw}.research.sqlite`),
    facts: resolve(env.FACTS_DATABASE_PATH || `${raw}.facts.sqlite`),
    sdk: resolve(env.DUELLOOP_DATABASE_PATH || `${raw}.duelloop.sqlite`),
  };
  const physicalPaths = Object.values(sources).map(physical);
  if (new Set(physicalPaths).size !== physicalPaths.length)
    throw new Error('Source databases must have distinct physical paths');
  const inodes = Object.values(sources)
    .filter(existsSync)
    .map((p) => {
      const s = statSync(p);
      return `${s.dev}:${s.ino}`;
    });
  if (new Set(inodes).size !== inodes.length)
    throw new Error('Source databases must not be hard-link aliases');
  const destination = physical(output);
  if (
    [...physicalPaths, physical(envPath)].some(
      (p) => p === destination || p.startsWith(destination + sep),
    )
  )
    throw new Error('Migration output may not contain a source file');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const backups = join(output, 'backups');
  const working = join(output, 'working');
  mkdirSync(backups, { mode: 0o700 });
  mkdirSync(working, { mode: 0o700 });
  const copies = Object.fromEntries(
    Object.keys(sources).map((k) => [k, join(working, `${k}.sqlite`)]),
  ) as Record<Category, string>;
  const snapshots: Record<string, unknown> = {};
  for (const [category, source] of Object.entries(sources) as [Category, string][]) {
    if (!existsSync(source)) {
      snapshots[category] = { present: false };
      continue;
    }
    const target = join(backups, `${category}.sqlite`);
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(db, target);
    } finally {
      db.close();
    }
    chmodSync(target, 0o600);
    snapshots[category] = {
      present: true,
      backup: `backups/${category}.sqlite`,
      sha256: await hashDatabase(target),
      ...inspect(target),
    };
    copyFileSync(target, copies[category]);
    chmodSync(copies[category], 0o600);
  }
  const protocols: Record<string, unknown> = {};
  const protocolPaths: Record<string, string> = {};
  for (const [name, key] of [
    ['development', 'DUELLOOP_DEVELOPMENT_PROTOCOL'],
    ['final', 'DUELLOOP_FINAL_PROTOCOL'],
  ] as const) {
    const source = resolve(env[key] || `data/protocols/${name}.json`);
    const target = join(working, `protocol-${name}.json`);
    protocolPaths[key] = target;
    if (!existsSync(source)) {
      protocols[name] = { present: false };
      continue;
    }
    const body = readFileSync(source);
    JSON.parse(body.toString('utf8'));
    for (const path of [join(backups, `protocol-${name}.json`), target])
      writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
    protocols[name] = { present: true, sha256: createHash('sha256').update(body).digest('hex') };
  }
  const before = inspect(copies.raw);
  const store = new Store(copies.raw, env.JEV_MODEL);
  let history: { runs: number; hands: number; decisions: number };
  let blockers: { pendingActions: number; decisionBlock: number };
  try {
    new HostJournal(store.db);
    const queries = new Queries(store);
    const runs = queries.runs({ limit: 3 });
    const hands = queries.hands(undefined, { limit: 3 });
    for (const hand of hands) queries.hand(hand.id);
    const decisions = store.db
      .prepare('SELECT id FROM decisions ORDER BY created_at DESC LIMIT 3')
      .all();
    for (const row of decisions)
      if (!queries.decision(String(row.id))) throw new Error('Legacy decision unreadable');
    history = { runs: runs.length, hands: hands.length, decisions: decisions.length };
    blockers = {
      pendingActions: Number(
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM actions WHERE status IN ('prepared','sent','unresolved')",
          )
          .get()!.n,
      ),
      decisionBlock: Number(
        store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='decision_block'").get()!.n,
      ),
    };
    for (const [table, count] of Object.entries(before.tables)) {
      // Additive schema metadata can acquire new entries; original history tables cannot lose rows.
      if (Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get()!.n) < count)
        throw new Error(`Migration lost rows in ${table}`);
    }
  } finally {
    store.close();
  }
  const sdk = new SqliteStore(copies.sdk);
  sdk.close();
  chmodSync(copies.sdk, 0o600);
  const upgraded = { raw: inspect(copies.raw), sdk: inspect(copies.sdk) };
  const removedKeys = Object.keys(env).filter((k) => retired.test(k));
  const next: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !retired.test(entry[0]),
    ),
  );
  Object.assign(next, protocolPaths, {
    AUTO_START_BOT: 'false',
    DUELLOOP_RESEARCH_ENABLED: 'false',
    BOT_STRATEGY: 'jev',
    FACTS_ENABLED: env.FACTS_ENABLED ?? (env.RESEARCH_ENABLED === 'false' ? 'false' : 'true'),
    DATABASE_PATH: copies.raw,
    KNOWLEDGE_DATABASE_PATH: copies.knowledge,
    RESEARCH_DATABASE_PATH: copies.research,
    FACTS_DATABASE_PATH: copies.facts,
    DUELLOOP_DATABASE_PATH: copies.sdk,
  });
  writeFileSync(join(output, '.env.next'), encodeMigrationEnv(next), { mode: 0o600, flag: 'wx' });
  const compose = writeMigrationCompose(output, next);
  const manifest = {
    version: 'duelloop-copy-v2',
    createdAt: new Date().toISOString(),
    output,
    compose,
    snapshots,
    protocols,
    upgraded,
    historyReaderSamples: history!,
    preservedBlockers: blockers!,
    removedKeys,
    autoStart: false,
    researchEnabled: false,
  };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return manifest;
}
