import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('refuses model diagnostics and paired calls without an explicit paid flag, before reading input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-private-cli-'));
  try {
    for (const op of ['diagnose', 'pair-run']) {
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
            RESEARCH_DATABASE_PATH: join(dir, 'research.sqlite'),
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--allow-paid');
      expect(result.stdout).toBe('');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
