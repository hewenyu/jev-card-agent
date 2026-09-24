import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const version = process.argv[2] ?? '0.2.2';
const commits = {
  '0.2.1': 'cba13bb69453f7ea2cd7a79db9d3fbe9859eabc4',
  '0.2.2': '7b518d21406b52c8dbc83a34031ee6f626237b4b',
};
const commit = commits[version];
if (!commit) throw new Error('Unsupported SDK archive version');
const tag = `v${version}`;
const releaseUrl =
  version === '0.2.2'
    ? `https://github.com/hewenyu/DuelLoop/releases/download/${tag}/duelloop-${version}.tgz`
    : undefined;
const temporary = mkdtempSync(join(tmpdir(), 'duelloop-source-'));
const source = join(temporary, 'source');
const archive = `duelloop-${version}.tgz`;
const checkedIn = fileURLToPath(new URL(`../vendor/${archive}`, import.meta.url));
const execute = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'pipe' });
try {
  execute(
    'git',
    ['clone', '--quiet', '--no-checkout', 'https://github.com/hewenyu/DuelLoop.git', source],
    temporary,
  );
  const taggedCommit = execute('git', ['rev-parse', `${tag}^{commit}`], source)
    .toString()
    .trim();
  if (taggedCommit !== commit)
    throw new Error('DuelLoop release tag differs from the pinned commit');
  execute('git', ['checkout', '--quiet', '--detach', tag], source);
  execute('npm', ['ci', '--ignore-scripts'], source);
  execute('npm', ['pack', '--pack-destination', temporary], source);
  const reproduced = readFileSync(join(temporary, archive));
  if (!reproduced.equals(readFileSync(checkedIn)))
    throw new Error('DuelLoop archive differs from the pinned public build');
  if (releaseUrl) {
    const response = await fetch(releaseUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`DuelLoop release asset returned HTTP ${response.status}`);
    if (!reproduced.equals(Buffer.from(await response.arrayBuffer())))
      throw new Error('DuelLoop release asset differs from the tagged public build');
  }
  console.log(
    JSON.stringify(
      {
        commit,
        tag,
        releaseUrl,
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
