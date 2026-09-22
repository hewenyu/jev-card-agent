import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  AdviceStore,
  APPROVED_RECIPE_ID,
  GUIDANCE_RECIPE_ID,
} from '../src/knowledge/advice-store.js';

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

it('approves the bounded guidance contract separately through the private CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-guidance-cli-'));
  const path = join(dir, 'research.sqlite');
  let advice: AdviceStore | undefined;
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli/research.ts'),
        '--op',
        'approve-guidance',
        '--actor',
        'test-operator',
        '--note',
        'Independently reviewed the guidance evidence and scope contract.',
      ],
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
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ approvedRecipe: GUIDANCE_RECIPE_ID });
    advice = new AdviceStore(path);
    expect(
      advice.db.prepare('SELECT id FROM advice_recipes WHERE id=?').get(GUIDANCE_RECIPE_ID),
    ).toBeDefined();
    expect(
      advice.db.prepare('SELECT id FROM advice_recipes WHERE id=?').get(APPROVED_RECIPE_ID),
    ).toBeUndefined();
    expect(advice.listAudit()[0]).toMatchObject({
      action: 'recipe_approved',
      subjectId: GUIDANCE_RECIPE_ID,
    });
    expect(advice.listPublications()).toEqual([]);
  } finally {
    advice?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
