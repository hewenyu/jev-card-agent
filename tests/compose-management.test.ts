import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
const manage = resolve('scripts/manage.sh');
const compatibility = resolve('scripts/update-container.sh');
const psRunning = ['compose', 'ps', '--status', 'running', '-q', 'app'];
const exec = ['compose', 'exec', '-T', 'app', 'node', '--input-type=module'];
const recreate = ['compose', 'up', '-d', '--no-deps', '--force-recreate', 'app'];
const backupPath = '/app/data/backups/jev-2025-01-01T00-00-00-000Z.sqlite';

// Every invocation is intercepted by this temporary binary. The child environment
// contains no inherited credentials, Docker context, or application configuration.
const fakeDocker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(entry) + '\n');
log(args);
if (args[0] !== 'compose') process.exit(90);
const action = args[1];
if (action === 'ps' && args.includes('--status')) {
  if (process.env.FAIL_PS === '1') process.exit(19);
  if (process.env.TEST_RUNNING === '1') process.stdout.write('fake-container\n');
} else if (action === 'exec') {
  const source = fs.readFileSync(0, 'utf8');
  if (source.includes('/api/runtime/resume')) {
    if (!source.includes('http://127.0.0.1:') || !source.includes("method: 'POST'") ||
        !source.includes('process.env.API_TOKEN') || !source.includes('Authorization:')) process.exit(93);
    log(['resume-start', 'POST', 'loopback', 'backend-token']);
    if (process.env.FAIL_RESUME === '1') process.exit(41);
    log(['resume-complete']);
  } else if (source.includes('DatabaseSync')) {
    if (!source.includes('await backup(db, target)')) process.exit(91);
    log(['backup-start']);
    if (process.env.FAIL_BACKUP === '1') process.exit(31);
    process.stdout.write(process.env.TEST_BACKUP_PATH + '\n');
    log(['backup-complete']);
  } else {
    if (!source.includes('/api/runtime/stop') || !source.includes('client.activeGame')) process.exit(92);
    log(['drain-start']);
    if (process.env.FAIL_DRAIN === '1') process.exit(23);
    log(['drain-complete']);
  }
} else if (action === 'pull') {
  if (process.env.FAIL_PULL === '1') process.exit(29);
} else if (action === 'cp') {
  if (process.env.FAIL_COPY === '1') process.exit(37);
  fs.writeFileSync(path.join(args[3], path.basename(args[2])), 'SQLite backup fixture');
}
`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jev-compose-test-'));
  temporary.push(directory);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const docker = join(bin, 'docker');
  writeFileSync(docker, `#!${process.execPath}\n${fakeDocker}`);
  chmodSync(docker, 0o700);
  const log = join(directory, 'calls.jsonl');
  return {
    directory,
    run(
      action: string,
      overrides: Record<string, string> = {},
      args: string[] = [],
      script = manage,
    ) {
      const result = spawnSync('/bin/sh', [script, action, ...args], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          TEST_LOG: log,
          TEST_RUNNING: '1',
          TEST_BACKUP_PATH: backupPath,
          ...overrides,
        },
      });
      const calls: string[][] = existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
      return { ...result, calls };
    },
  };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('manual Compose management', () => {
  it.each(['stop', 'restart', 'update'])(
    'waits for drain success before %s changes the container',
    (action) => {
      const { calls, status } = fixture().run(action);
      expect(status).toBe(0);
      expect(calls).toEqual([
        psRunning,
        exec,
        ['drain-start'],
        ['drain-complete'],
        ...(action === 'update' ? [['compose', 'pull', 'app']] : []),
        action === 'stop' ? ['compose', 'stop', 'app'] : recreate,
        ['compose', 'ps'],
      ]);
    },
  );

  it.each(['stop', 'restart', 'update'])(
    'leaves the container unchanged when drain fails during %s',
    (action) => {
      const { calls, status } = fixture().run(action, { FAIL_DRAIN: '1' });
      expect(status).toBe(23);
      expect(calls).toEqual([psRunning, exec, ['drain-start']]);
    },
  );

  it.each(['start', 'stop', 'restart', 'update'])(
    'fails closed if Compose cannot establish whether %s is safe',
    (action) => {
      const { calls, status } = fixture().run(action, { FAIL_PS: '1' });
      expect(status).toBe(19);
      expect(calls).toEqual([psRunning]);
    },
  );

  it('does not recreate a drained container after an unsuccessful image pull', () => {
    const { calls, status } = fixture().run('update', { FAIL_PULL: '1' });
    expect(status).toBe(29);
    expect(calls).toEqual([
      psRunning,
      exec,
      ['drain-start'],
      ['drain-complete'],
      ['compose', 'pull', 'app'],
    ]);
  });

  it('starts a stopped service using Compose without executing a container drain', () => {
    const { calls, status } = fixture().run('start', { TEST_RUNNING: '0' });
    expect(status).toBe(0);
    expect(calls).toEqual([psRunning, ['compose', 'up', '-d', 'app'], ['compose', 'ps']]);
  });

  it('preserves an already running service when start is requested', () => {
    const { calls, status } = fixture().run('start');
    expect(status).toBe(0);
    expect(calls).toEqual([psRunning, ['compose', 'ps']]);
  });

  it('updates a stopped service without requiring exec inside the stopped container', () => {
    const { calls, status } = fixture().run('update', { TEST_RUNNING: '0' });
    expect(status).toBe(0);
    expect(calls).toEqual([psRunning, ['compose', 'pull', 'app'], recreate, ['compose', 'ps']]);
  });

  it('uses only Compose for status and logs and preserves log arguments', () => {
    expect(fixture().run('status').calls).toEqual([['compose', 'ps']]);
    expect(fixture().run('logs', {}, ['--since', '10m']).calls).toEqual([
      ['compose', 'logs', '--tail', '100', '-f', '--since', '10m', 'app'],
    ]);
  });

  it('resumes through authenticated loopback inside Compose without recreating or publishing controls', () => {
    const { calls, status } = fixture().run('resume');
    expect(status).toBe(0);
    expect(calls).toEqual([
      exec,
      ['resume-start', 'POST', 'loopback', 'backend-token'],
      ['resume-complete'],
      ['compose', 'ps'],
    ]);
  });

  it('propagates a refused resume without restarting the container or claiming success', () => {
    const { calls, status, stdout } = fixture().run('resume', { FAIL_RESUME: '1' });
    expect(status).toBe(41);
    expect(calls).toEqual([exec, ['resume-start', 'POST', 'loopback', 'backend-token']]);
    expect(stdout).not.toContain('Bot resumed');
  });

  it('runs the legacy update entry point through the same drain and Compose sequence', () => {
    const { calls, status } = fixture().run('', {}, [], compatibility);
    expect(status).toBe(0);
    expect(calls).toEqual([
      psRunning,
      exec,
      ['drain-start'],
      ['drain-complete'],
      ['compose', 'pull', 'app'],
      recreate,
      ['compose', 'ps'],
    ]);
  });

  it('copies a completed SQLite snapshot to a private local backup using Compose', () => {
    const test = fixture();
    const { calls, status, stdout } = test.run('backup');
    expect(status).toBe(0);
    expect(calls).toEqual([
      exec,
      ['backup-start'],
      ['backup-complete'],
      ['compose', 'cp', `app:${backupPath}`, 'data/backups/'],
    ]);
    const target = join(test.directory, 'data/backups', basename(backupPath));
    expect(readFileSync(target, 'utf8')).toBe('SQLite backup fixture');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(test.directory, 'data/backups')).mode & 0o777).toBe(0o700);
    expect(stdout).toContain(`Consistent SQLite backup: data/backups/${basename(backupPath)}`);
  });

  it('does not copy or claim success when snapshot creation fails', () => {
    const { status, calls, stdout } = fixture().run('backup', { FAIL_BACKUP: '1' });
    expect(status).toBe(31);
    expect(calls).toEqual([exec, ['backup-start']]);
    expect(stdout).not.toContain('Consistent SQLite backup');
  });

  it('rejects unexpected snapshot paths before copying', () => {
    const { status, calls, stderr } = fixture().run('backup', {
      TEST_BACKUP_PATH: '/app/data/jev.sqlite',
    });
    expect(status).toBe(1);
    expect(calls).toEqual([exec, ['backup-start'], ['backup-complete']]);
    expect(stderr).toContain('unexpected container path');
  });

  it('does not report success if the backup cannot be copied', () => {
    const { status, stdout } = fixture().run('backup', { FAIL_COPY: '1' });
    expect(status).toBe(37);
    expect(stdout).not.toContain('Consistent SQLite backup');
  });

  it('rejects unsupported actions without invoking Docker', () => {
    const { status, calls, stderr } = fixture().run('delete-everything');
    expect(status).toBe(2);
    expect(calls).toEqual([]);
    expect(stderr).toContain('Usage:');
  });
});
