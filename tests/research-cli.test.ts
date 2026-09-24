import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('rejects retired advice publisher and comparison commands without creating a legacy writer or calling models', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-framework-cli-'));
  try {
    for (const op of ['diagnose', 'pair-run', 'approve-guidance', 'publish']) {
      const path = join(dir, 'research.sqlite');
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), resolve('src/cli/research.ts'), '--op', op],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 10000,
          env: {
            PATH: process.env.PATH,
            DATABASE_PATH: join(dir, 'raw.sqlite'),
            RESEARCH_DATABASE_PATH: path,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Legacy advice publishing commands are retired');
      expect(result.stdout).toBe('');
      expect(existsSync(path)).toBe(false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('requires attribution and a release identity before sending authenticated approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-framework-cli-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), resolve('src/cli/research.ts'), '--op', 'approve'],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH, DATABASE_PATH: join(dir, 'raw.sqlite') },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--release is required');
    expect(result.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
