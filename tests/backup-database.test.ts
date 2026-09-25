import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const script = resolve('scripts/backup-database.mjs');
function fixture(mode = '') {
  const directory = mkdtempSync(join(tmpdir(), 'jev-backup-'));
  directories.push(directory);
  const raw = join(directory, 'raw.sqlite');
  const db = new DatabaseSync(raw);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE history(value); INSERT INTO history VALUES(zeroblob(2097152))',
  );
  const archiveDirectory = join(directory, 'archives');
  const original = readFileSync(raw);
  const wal = readFileSync(`${raw}-wal`);
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const mode = ${JSON.stringify(mode)};
      if (mode === 'space') fs.statfsSync = () => ({bavail: 0n, bsize: 4096n});
      if (mode === 'corrupt') {
        const original = fs.createReadStream;
        fs.createReadStream = function(path, ...args) {
          if (String(path).endsWith('.gz')) fs.writeFileSync(path, 'corrupted gzip');
          return original.call(this, path, ...args);
        };
      }
      syncBuiltinESMExports();
      globalThis.fetch = async (url) => {
        if (mode === 'running') return {ok: true, json: async () => ({runtime: {running: true}})};
        process.stderr.write(new URL(url).pathname + '\\n');
        return {ok: true, json: async () => ({runtime: {running: false}})};
      };
      await import(${JSON.stringify(script)});
    `,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      DATABASE_PATH: raw,
      BACKUP_DIRECTORY: archiveDirectory,
      DUELLOOP_DEVELOPMENT_PROTOCOL: join(directory, 'absent-development.json'),
      DUELLOOP_FINAL_PROTOCOL: join(directory, 'absent-final.json'),
    },
  });
  expect(readFileSync(raw)).toEqual(original);
  expect(readFileSync(`${raw}-wal`)).toEqual(wal);
  db.close();
  return { directory, archiveDirectory, result };
}

describe('compressed release backups', () => {
  it('restores all committed WAL data from a checked gzip snapshot without retaining an uncompressed duplicate', () => {
    const { directory, archiveDirectory, result } = fixture();
    expect(result.status, result.stderr).toBe(0);
    const paths = result.stdout.trim().split('\n');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/\.sqlite\.gz$/);
    const files = readdirSync(archiveDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.sqlite\.gz$/);
    expect(statSync(paths[0]!).mode & 0o777).toBe(0o600);
    const restored = join(directory, 'restored.sqlite');
    writeFileSync(restored, gunzipSync(readFileSync(paths[0]!)));
    const db = new DatabaseSync(restored, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' });
      expect(db.prepare('SELECT length(value) n FROM history').get()).toMatchObject({ n: 2097152 });
    } finally {
      db.close();
    }
    expect(result.stderr).toContain('/api/research/pause');
    expect(result.stderr).not.toContain('/api/runtime/resume');
  });

  it('refuses insufficient capacity before writing a snapshot and leaves the runtime paused', () => {
    const { archiveDirectory, result } = fixture('space');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Insufficient backup space');
    expect(result.stderr).toContain('/api/research/pause');
    expect(result.stdout).toBe('');
    expect(readdirSync(archiveDirectory)).toEqual([]);
  });

  it('retains the SQLite snapshot when gzip verification fails and does not advertise an archive', () => {
    const { archiveDirectory, result } = fixture('corrupt');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    const files = readdirSync(archiveDirectory);
    expect(files.some((name) => name.endsWith('.sqlite'))).toBe(true);
    expect(files.some((name) => name.endsWith('.sqlite.gz'))).toBe(true);
  });

  it('refuses to write or pause research while the runtime still has action authority', () => {
    const { archiveDirectory, result } = fixture('running');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Drain the runtime');
    expect(existsSync(archiveDirectory)).toBe(false);
  });
});
