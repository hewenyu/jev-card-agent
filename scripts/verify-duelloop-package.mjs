import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const commit = 'cba13bb69453f7ea2cd7a79db9d3fbe9859eabc4';
const temporary = mkdtempSync(join(tmpdir(), 'duelloop-source-'));
const source = join(temporary, 'source');
const archive = 'duelloop-0.2.1.tgz';
const checkedIn = fileURLToPath(new URL(`../vendor/${archive}`, import.meta.url));
const execute = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'pipe' });
try {
  execute(
    'git',
    ['clone', '--quiet', '--no-checkout', 'https://github.com/hewenyu/DuelLoop.git', source],
    temporary,
  );
  execute('git', ['checkout', '--quiet', '--detach', commit], source);
  execute('npm', ['ci', '--ignore-scripts'], source);
  execute('npm', ['pack', '--pack-destination', temporary], source);
  const reproduced = readFileSync(join(temporary, archive));
  if (!reproduced.equals(readFileSync(checkedIn)))
    throw new Error('DuelLoop archive differs from the pinned public build');
  console.log(
    JSON.stringify(
      {
        commit,
        bytes: reproduced.length,
        sha256: createHash('sha256').update(reproduced).digest('hex'),
        reproduced: true,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
