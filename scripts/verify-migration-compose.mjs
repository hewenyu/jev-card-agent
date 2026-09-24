import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteStore } from 'duelloop';
import { buildContext, createInitialState } from '../src/core/index.ts';
import { Store } from '../src/storage/store.ts';
import { KnowledgeStore } from '../src/knowledge/store.ts';
import { AdviceStore } from '../src/knowledge/advice-store.ts';
import { FactsStore } from '../src/facts/store.ts';
import { migrateDuelLoop } from '../src/duelloop/host/migrate.ts';
import { createPokerPilotProtocols } from '../src/evaluation/poker/protocol.ts';
import { POKER_DOMAIN_ID } from '../src/poker/domain.ts';

// Run only against an explicitly chosen production image; never read the repository .env.
const imageIndex = process.argv.indexOf('--image');
if (imageIndex < 0 || !process.argv[imageIndex + 1]) throw new Error('--image is required');
const image = process.argv[imageIndex + 1];
const outputIndex = process.argv.indexOf('--report');
const directory = mkdtempSync(join(tmpdir(), 'jev-migration-compose-'));
const project = `jev-migration-${randomUUID().slice(0, 8)}`;
const output = join(directory, 'migration');
const original = join(directory, 'original');
const categories = ['raw', 'knowledge', 'research', 'facts', 'sdk'];
const paths = Object.fromEntries(
  categories.map((category) => [category, join(original, `${category}.sqlite`)]),
);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const coordinatorHash = hash(resolve('dist/duelloop/live/coordinator.js'));
let holders = [];
let started = false;
function execute(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'docker',
      ['compose', '-p', project, '-f', join(output, 'compose.json'), ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DOCKER_HOST: process.env.DOCKER_HOST,
          DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(stdout.trim())
        : reject(new Error(`Compose ${args[0]} failed: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      await execute(
        ['exec', '-T', 'app', 'node', '--input-type=module'],
        "const r=await fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(1000)}); if(!r.ok)process.exit(1);",
      );
      return;
    } catch {
      /* Startup may still be in progress. */
    }
    await delay(500);
  }
  throw new Error(
    `Migrated container did not become healthy: ${await execute(['logs', '--tail', '40'])}`,
  );
}
async function history() {
  const get = async (path) => {
    return JSON.parse(
      await execute(
        ['exec', '-T', 'app', 'node', '--input-type=module'],
        `const r=await fetch('http://127.0.0.1:8787'+${JSON.stringify(path)},{signal:AbortSignal.timeout(10000)}); if(r.status!==200)throw new Error('HTTP status '+r.status); process.stdout.write(JSON.stringify(await r.json()));`,
      ),
    );
  };
  assert.ok((await get('/api/runs')).some((run) => run.id === 'migration-history'));
  const hands = await get('/api/hands');
  assert.equal(hands.length, 1);
  await get(`/api/hands/${encodeURIComponent(hands[0].id)}`);
  const decision = await get('/api/decisions/migration-decision');
  assert.equal(decision.id, 'migration-decision');
  assert.equal((await get('/api/overview')).runtime.running, false);
}
function inspection(write = false, persisted = false) {
  return `import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validatePokerProtocols } from './dist/evaluation/poker/protocol.js';
assert.equal(createHash('sha256').update(readFileSync('./dist/duelloop/live/coordinator.js')).digest('hex'), ${JSON.stringify(coordinatorHash)});
const names = ${JSON.stringify(categories)};
const keys = ['DATABASE_PATH','KNOWLEDGE_DATABASE_PATH','RESEARCH_DATABASE_PATH','FACTS_DATABASE_PATH','DUELLOOP_DATABASE_PATH'];
for (let i=0; i<names.length; i++) {
  assert.equal(process.env[keys[i]], '/app/data/'+names[i]+'.sqlite');
  const db = new DatabaseSync(process.env[keys[i]]);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare('SELECT value FROM wal_marker').get().value, names[i]+'-committed');
  ${write ? "db.exec('CREATE TABLE persistence_marker(value); INSERT INTO persistence_marker VALUES(42)');" : ''}
  ${persisted ? "assert.equal(db.prepare('SELECT value FROM persistence_marker').get().value, 42);" : ''}
  if (names[i]==='raw') {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status='unresolved'").get().n,1);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='decision_block'").get().value,'{"reason":"migration-preserve"}');
  }
  db.close();
}
assert.equal(existsSync('/app/data/jev.sqlite'), false);
assert.equal(process.env.AUTO_START_BOT,'false');
assert.equal(process.env.DUELLOOP_RESEARCH_ENABLED,'false');
validatePokerProtocols(JSON.parse(readFileSync(process.env.DUELLOOP_DEVELOPMENT_PROTOCOL)),JSON.parse(readFileSync(process.env.DUELLOOP_FINAL_PROTOCOL)));
console.log('five stores, original blockers and protocol pair verified');`;
}
try {
  mkdirSync(original, { mode: 0o700 });
  const raw = new Store(paths.raw);
  raw.db
    .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'migration-history',
      'live',
      'jev',
      'jev-1.13.0',
      'stopped',
      '2026-01-01',
      null,
      null,
      '{}',
    );
  raw.db
    .prepare('INSERT INTO actions VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'migration-action',
      'migration-history',
      'migration-decision',
      'table',
      '{}',
      'unresolved',
      '2026-01-01',
      123,
      null,
    );
  raw.db
    .prepare('INSERT INTO meta VALUES(?,?)')
    .run('decision_block', '{"reason":"migration-preserve"}');
  const state = {
    ...createInitialState(),
    tableId: 'table',
    handId: 'migration-hand',
    heroSeat: 0,
    holeCards: ['Ah', 'Kd'],
    complete: true,
    handStartStacks: { 0: 1000 },
  };
  raw.saveHand('migration-history', state, {
    type: 'hand_result',
    final_stacks: { 0: 1120 },
    ts: '2026-01-02',
  });
  raw.saveDecision({
    id: 'migration-decision',
    runId: 'migration-history',
    handId: 'migration-hand',
    createdAt: '2026-01-01',
    context: buildContext(state),
    candidates: [{ id: 'check', action: 'check', label: 'Check' }],
    proposal: {
      candidateId: 'check',
      selected: 'check',
      source: 'jev',
      latencyMs: 1,
      explanation: 'Synthetic migration evidence',
    },
    fallbackReason: null,
  });
  raw.close();
  new KnowledgeStore(paths.knowledge).close();
  new AdviceStore(paths.research).close();
  new FactsStore(paths.facts).close();
  new SqliteStore(paths.sdk).close();
  holders = categories.map((name) => {
    const db = new DatabaseSync(paths[name]);
    db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_marker(value TEXT); INSERT INTO wal_marker VALUES('${name}-committed')`,
    );
    return db;
  });
  const originalHashes = Object.fromEntries(
    categories.map((name) => [name, { main: hash(paths[name]), wal: hash(paths[name] + '-wal') }]),
  );
  const protocols = createPokerPilotProtocols(POKER_DOMAIN_ID, 10000);
  for (const name of ['development', 'final'])
    writeFileSync(join(original, name + '.json'), JSON.stringify(protocols[name]), { mode: 0o600 });
  const env = join(original, '.env');
  writeFileSync(
    env,
    [
      'PUBLIC_HISTORY=true',
      'API_TOKEN=synthetic-migration-check-only',
      'FACTS_ENABLED=false',
      'AUTO_START_BOT=false',
      'DUELLOOP_RESEARCH_ENABLED=false',
      `KNOWLEDGE_DATABASE_PATH='${paths.knowledge}'`,
      `RESEARCH_DATABASE_PATH='${paths.research}'`,
      `FACTS_DATABASE_PATH='${paths.facts}'`,
      `DUELLOOP_DATABASE_PATH='${paths.sdk}'`,
      `DUELLOOP_DEVELOPMENT_PROTOCOL='${join(original, 'development.json')}'`,
      `DUELLOOP_FINAL_PROTOCOL='${join(original, 'final.json')}'`,
    ].join('\n'),
    { mode: 0o600 },
  );
  const manifest = await migrateDuelLoop({ database: paths.raw, env, output });
  assert.deepEqual(manifest.preservedBlockers, { pendingActions: 1, decisionBlock: 1 });
  for (const name of categories) {
    assert.equal(hash(paths[name]), originalHashes[name].main);
    assert.equal(hash(paths[name] + '-wal'), originalHashes[name].wal);
  }
  const preservedHashes = Object.fromEntries(
    categories.map((name) => [name, hash(join(output, 'backups', name + '.sqlite'))]),
  );
  // Use the generated handoff, changing only isolated-test image/port/network settings.
  const composePath = join(output, 'compose.json');
  const compose = JSON.parse(readFileSync(composePath, 'utf8'));
  compose.services.app.image = image;
  compose.services.app.ports = ['127.0.0.1::8787'];
  compose.services.app.restart = 'no';
  compose.networks = { default: { internal: true } };
  writeFileSync(composePath, JSON.stringify(compose));
  started = true;
  await execute(['up', '-d', '--pull', 'never']);
  await ready();
  await history();
  await execute(['exec', '-T', 'app', 'node', '--input-type=module'], inspection(true));
  await execute(['up', '-d', '--force-recreate', '--pull', 'never']);
  await ready();
  await history();
  await execute(['exec', '-T', 'app', 'node', '--input-type=module'], inspection(false, true));
  await execute(['down']);
  started = false;
  const rollback = join(output, 'rollback');
  mkdirSync(rollback, { mode: 0o700 });
  for (const name of categories) {
    assert.equal(hash(join(output, 'backups', name + '.sqlite')), preservedHashes[name]);
    copyFileSync(join(output, 'backups', name + '.sqlite'), join(rollback, name + '.sqlite'));
    chmodSync(join(rollback, name + '.sqlite'), 0o600);
    assert.equal(hash(join(rollback, name + '.sqlite')), preservedHashes[name]);
  }
  for (const name of ['development', 'final'])
    copyFileSync(
      join(output, 'backups', `protocol-${name}.json`),
      join(rollback, `protocol-${name}.json`),
    );
  compose.services.app.volumes[0].source = './rollback';
  writeFileSync(composePath, JSON.stringify(compose));
  started = true;
  await execute(['up', '-d', '--pull', 'never']);
  await ready();
  await history();
  await execute(['exec', '-T', 'app', 'node', '--input-type=module'], inspection());
  for (const name of categories) {
    assert.equal(hash(join(output, 'backups', name + '.sqlite')), preservedHashes[name]);
    assert.equal(hash(paths[name]), originalHashes[name].main);
    assert.equal(hash(paths[name] + '-wal'), originalHashes[name].wal);
  }
  const report = {
    productionImage: image,
    coordinatorSha256: coordinatorHash,
    imageMatchesLocalBuild: 'passed',
    generatedComposeHandoff: 'passed',
    fiveCommittedWalStores: 'passed',
    historyHttpReaders: 'passed',
    privateProtocolAccess: 'passed',
    blockerPreservation: 'passed',
    forceRecreatePersistence: 'passed',
    restoredOriginalCopies: 'passed',
    originalAndBackupBytes: 'unchanged',
    previousReleaseImage: 'not tested; restored copies read using the selected production image',
    arenaConnected: false,
    modelRequests: 0,
  };
  if (outputIndex >= 0) {
    const reportPath = resolve(process.argv[outputIndex + 1]);
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (started) await execute(['down', '--volumes']).catch(() => {});
  holders.forEach((db) => db.close());
  rmSync(directory, { recursive: true, force: true });
}
