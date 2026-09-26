import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { buildContext, createInitialState } from '../src/core/index.js';
import { Store } from '../src/storage/store.js';
import { migrateDuelLoop } from '../src/duelloop/host/migrate.js';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const directories: string[] = [];
afterEach(() => {
  for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'duelloop-migrate-'));
  directories.push(directory);
  const database = join(directory, 'raw.sqlite');
  const env = join(directory, '.env');
  const store = new Store(database);
  store.db
    .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)')
    .run('legacy', 'live', 'jev', 'jev-1.13.0', 'stopped', '2026-01-01', null, null, '{}');
  store.db
    .prepare('INSERT INTO actions VALUES(?,?,?,?,?,?,?,?,?)')
    .run('action', 'legacy', 'decision', 'table', '{}', 'unresolved', '2026-01-01', 123, null);
  const state = {
    ...createInitialState(),
    tableId: 'table',
    handId: 'legacy-hand',
    heroSeat: 0,
    holeCards: ['Ah', 'Kd'],
    complete: true,
    handStartStacks: { '0': 1000 },
  };
  store.saveHand('legacy', state, {
    type: 'hand_result',
    final_stacks: { '0': 1120 },
    ts: '2026-01-02',
  });
  store.saveDecision({
    id: 'decision',
    runId: 'legacy',
    handId: 'legacy-hand',
    createdAt: '2026-01-01',
    context: buildContext(state),
    candidates: [{ id: 'check', action: 'check', label: 'Check' }],
    proposal: {
      candidateId: 'check',
      selected: 'check',
      source: 'jev',
      latencyMs: 1,
      explanation: 'Legacy decision',
    },
    fallbackReason: null,
  });
  store.db.prepare('INSERT INTO meta VALUES(?,?)').run('decision_block', '{"reason":"preserve"}');
  store.close();
  writeFileSync(
    env,
    'JEV_API_KEY=secret-jev\nDEEPSEEK_API_KEY=secret-deepseek\nASYNC_LLM_MODE=enabled\nLLM_RESEARCH_OLD=true\nREASONING_MODE=always\nRESEARCH_ENABLED=false\n',
  );
  return { directory, database, env, output: join(directory, 'out') };
}
describe('copy-only migration', () => {
  it.each([false, true])(
    'migrates legacy model settings without overwriting explicit research settings (%s)',
    async (explicit) => {
      const f = fixture();
      writeFileSync(
        f.env,
        readFileSync(f.env, 'utf8') +
          [
            'DEEPSEEK_MODEL=deepseek-v4-pro',
            'DEEPSEEK_BASE_URL=https://legacy-research.example/anthropic',
            'DEEPSEEK_API_BASE_URL=https://offline-only.example/anthropic',
            'DEEPSEEK_THINKING=disabled',
            'REASONING_API_KEY=secret-standard',
            ...(explicit
              ? [
                  'DUELLOOP_RESEARCH_API_KEY=secret-explicit',
                  'DUELLOOP_RESEARCH_MODEL=deepseek-flash',
                  'DUELLOOP_RESEARCH_BASE_URL=https://explicit.example/anthropic',
                ]
              : []),
            '',
          ].join('\n'),
      );
      const manifest = await migrateDuelLoop(f);
      const next = parseEnv(readFileSync(join(f.output, '.env.next'), 'utf8'));
      expect(next).toMatchObject({
        DUELLOOP_RESEARCH_API_KEY: explicit ? 'secret-explicit' : 'secret-deepseek',
        DUELLOOP_RESEARCH_MODEL: explicit ? 'deepseek-flash' : 'deepseek-v4-pro',
        DUELLOOP_RESEARCH_BASE_URL: explicit
          ? 'https://explicit.example/anthropic'
          : 'https://legacy-research.example/anthropic',
        DUELLOOP_RESEARCH_ENABLED: 'false',
      });
      expect(Object.keys(next).some((key) => /^(DEEPSEEK_|REASONING_)/.test(key))).toBe(false);
      expect(next.DUELLOOP_RESEARCH_THINKING).toBeUndefined();
      expect(JSON.stringify(manifest)).not.toContain('secret-');
    },
  );
  it('hashes multi-chunk snapshots without loading a whole database into a Buffer', async () => {
    const f = fixture();
    const db = new DatabaseSync(f.database);
    db.exec(
      'CREATE TABLE large_payload(value); INSERT INTO large_payload VALUES(zeroblob(2097152))',
    );
    db.close();
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).readFileSync;
    vi.mocked(readFileSync).mockImplementation((...args: Parameters<typeof readFileSync>) => {
      if (String(args[0]).endsWith('.sqlite'))
        throw new Error('Whole-database reads are forbidden');
      return original(...args);
    });
    let manifest;
    try {
      manifest = await migrateDuelLoop(f);
    } finally {
      vi.mocked(readFileSync).mockImplementation(original);
    }
    const backup = readFileSync(join(f.output, 'backups/raw.sqlite'));
    expect(backup.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    expect(manifest.snapshots.raw).toMatchObject({
      sha256: createHash('sha256').update(backup).digest('hex'),
    });
  });
  it('preserves original bytes and blockers, initializes separate schemas and excludes secrets from manifest', async () => {
    const f = fixture();
    const raw = readFileSync(f.database);
    const env = readFileSync(f.env);
    const manifest = await migrateDuelLoop(f);
    expect(readFileSync(f.database)).toEqual(raw);
    expect(readFileSync(f.env)).toEqual(env);
    expect(manifest.preservedBlockers).toEqual({ pendingActions: 1, decisionBlock: 1 });
    expect(manifest.historyReaderSamples).toEqual({ runs: 1, hands: 1, decisions: 1 });
    expect(JSON.stringify(manifest)).not.toMatch(/secret-jev|secret-deepseek/);
    expect(readFileSync(join(f.output, 'backups/raw.sqlite'))).toBeDefined();
    expect(statSync(f.output).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.output, '.env.next')).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.output, '.env.compose')).mode & 0o777).toBe(0o600);
    const next = parseEnv(readFileSync(join(f.output, '.env.next'), 'utf8'));
    expect(next).toMatchObject({
      JEV_API_KEY: 'secret-jev',
      DUELLOOP_RESEARCH_API_KEY: 'secret-deepseek',
      AUTO_START_BOT: 'false',
      DUELLOOP_RESEARCH_ENABLED: 'false',
      FACTS_ENABLED: 'false',
      BOT_STRATEGY: 'jev',
    });
    expect(next.DEEPSEEK_API_KEY).toBeUndefined();
    expect(next.REASONING_MODE).toBeUndefined();
    expect(next.ASYNC_LLM_MODE).toBeUndefined();
    expect(next.LLM_RESEARCH_OLD).toBeUndefined();
    expect(next.DUELLOOP_DATABASE_PATH).not.toBe(next.DATABASE_PATH);
    const container = parseEnv(readFileSync(join(f.output, '.env.compose'), 'utf8'));
    expect(container).toMatchObject({
      DATABASE_PATH: '/app/data/raw.sqlite',
      KNOWLEDGE_DATABASE_PATH: '/app/data/knowledge.sqlite',
      RESEARCH_DATABASE_PATH: '/app/data/research.sqlite',
      FACTS_DATABASE_PATH: '/app/data/facts.sqlite',
      DUELLOOP_DATABASE_PATH: '/app/data/sdk.sqlite',
      DUELLOOP_DEVELOPMENT_PROTOCOL: '/app/data/protocol-development.json',
      DUELLOOP_FINAL_PROTOCOL: '/app/data/protocol-final.json',
      AUTO_START_BOT: 'false',
      DUELLOOP_RESEARCH_ENABLED: 'false',
    });
    const compose = JSON.parse(readFileSync(join(f.output, 'compose.json'), 'utf8'));
    expect(compose.services.app.volumes).toEqual([
      { type: 'bind', source: './working', target: '/app/data', bind: { create_host_path: false } },
    ]);
    expect(compose.services.app.environment).not.toHaveProperty('DATABASE_PATH');
    expect(compose.services.app.user).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(compose.volumes).toBeUndefined();
    const original = new DatabaseSync(f.database, { readOnly: true });
    expect(
      original.prepare("SELECT name FROM sqlite_master WHERE name='framework_hands'").get(),
    ).toBeUndefined();
    original.close();
    await expect(migrateDuelLoop(f)).rejects.toThrow('already exist');
  });
  it('backs up every available store and rejects physical aliases before creating output', async () => {
    const f = fixture();
    for (const suffix of ['knowledge', 'research', 'facts', 'duelloop']) {
      const db = new DatabaseSync(`${f.database}.${suffix}.sqlite`);
      db.exec('CREATE TABLE marker(value); INSERT INTO marker VALUES(1)');
      db.close();
    }
    const manifest = await migrateDuelLoop(f);
    expect(
      Object.values(manifest.snapshots).every((v) => (v as { present: boolean }).present),
    ).toBe(true);
    symlinkSync(f.database, join(f.directory, 'alias.sqlite'));
    writeFileSync(f.env, `FACTS_DATABASE_PATH=${join(f.directory, 'alias.sqlite')}\n`);
    await expect(
      migrateDuelLoop({ ...f, output: join(f.directory, 'alias-output') }),
    ).rejects.toThrow('distinct physical');
  });
  it('preserves dollar and escape characters for Node and rejects ambiguous shared encoding', async () => {
    const f = fixture();
    const values = {
      JEV_API_KEY: 'before$MISSING_VAR_after',
      PATH_TOKEN: 'one\\two',
      OTHER_TOKEN: 'has"quote',
      NOTE: "has'apostrophe",
    };
    writeFileSync(
      f.env,
      Object.entries(values)
        .map(([key, value]) => `${key}=\`${value}\``)
        .join('\n'),
    );
    const original = readFileSync(f.env);
    await migrateDuelLoop(f);
    expect(parseEnv(readFileSync(join(f.output, '.env.next'), 'utf8'))).toMatchObject(values);
    expect(readFileSync(f.env)).toEqual(original);
    writeFileSync(f.env, "JEV_API_KEY=`has'apostrophe$andDollar`\n");
    await expect(migrateDuelLoop({ ...f, output: join(f.directory, 'rejected') })).rejects.toThrow(
      'Node and Compose',
    );
  });

  it('copies committed WAL rows across all five stores and private protocols without changing originals', async () => {
    const f = fixture();
    const categories = ['raw', 'knowledge', 'research', 'facts', 'sdk'];
    const paths = [
      f.database,
      ...['knowledge', 'research', 'facts', 'duelloop'].map(
        (suffix) => `${f.database}.${suffix}.sqlite`,
      ),
    ];
    const databases = paths.map((path) => new DatabaseSync(path));
    try {
      databases.forEach((db, index) =>
        db.exec(
          `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_marker(value TEXT); INSERT INTO wal_marker VALUES('${categories[index]}-committed');`,
        ),
      );
      const originals = paths.map((path) => ({
        main: readFileSync(path),
        wal: readFileSync(`${path}-wal`),
      }));
      for (const name of ['development', 'final']) {
        const path = join(f.directory, `${name}.json`);
        writeFileSync(path, JSON.stringify({ id: name, seeds: [`private-${name}`] }));
      }
      writeFileSync(
        f.env,
        readFileSync(f.env, 'utf8') +
          `DUELLOOP_DEVELOPMENT_PROTOCOL='${join(f.directory, 'development.json')}'\nDUELLOOP_FINAL_PROTOCOL='${join(f.directory, 'final.json')}'\n`,
      );
      await migrateDuelLoop(f);
      paths.forEach((path, index) => {
        expect(readFileSync(path)).toEqual(originals[index]!.main);
        expect(readFileSync(`${path}-wal`)).toEqual(originals[index]!.wal);
        for (const section of ['backups', 'working']) {
          const copy = new DatabaseSync(join(f.output, section, `${categories[index]}.sqlite`), {
            readOnly: true,
          });
          try {
            expect(copy.prepare('SELECT value FROM wal_marker').get()!.value).toBe(
              `${categories[index]}-committed`,
            );
          } finally {
            copy.close();
          }
        }
      });
      for (const name of ['development', 'final']) {
        expect(readFileSync(join(f.output, 'working', `protocol-${name}.json`))).toEqual(
          readFileSync(join(f.directory, `${name}.json`)),
        );
      }
    } finally {
      databases.forEach((db) => db.close());
    }
  });

  it.runIf(spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0)(
    'preserves migrated synthetic credentials in actual Compose env_file parsing',
    async () => {
      const f = fixture();
      const values = {
        JEV_API_KEY: 'before$MISSING_VAR_after',
        PATH_TOKEN: 'one\\two',
        OTHER_TOKEN: 'has"quote',
        NOTE: "has'apostrophe",
      };
      writeFileSync(
        f.env,
        Object.entries(values)
          .map(([key, value]) => `${key}=\`${value}\``)
          .join('\n'),
      );
      await migrateDuelLoop(f);
      const compose = join(f.output, 'compose.json');
      const result = spawnSync('docker', ['compose', '-f', compose, 'config', '--format', 'json'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(result.stdout);
      // Compose's canonical config doubles literal dollars so the rendered file can be
      // consumed again. Its interpolation-environment output exposes the parsed value.
      expect(config.services.app.environment).toMatchObject(
        Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, v.replaceAll('$', () => '$$')]),
        ),
      );
      const parsed = spawnSync(
        'docker',
        [
          'compose',
          '--env-file',
          join(f.output, '.env.next'),
          '-f',
          compose,
          'config',
          '--environment',
        ],
        { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
      );
      expect(parsed.status, parsed.stderr).toBe(0);
      for (const [key, value] of Object.entries(values))
        expect(parsed.stdout.split('\n')).toContain(`${key}=${value}`);
    },
  );
});
