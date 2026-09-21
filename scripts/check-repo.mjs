import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const secrets = existsSync('.env')
  ? readFileSync('.env', 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const index = line.indexOf('=');
        const name = line.slice(0, index),
          value = line.slice(index + 1).replace(/^['"]|['"]$/g, '');
        return /(?:API_KEY|TOKEN|SECRET)$/.test(name) && value.length >= 12
          ? [{ name, value }]
          : [];
      })
  : [];
const problems = [];
let longest = { file: '', lines: 0 };
for (const file of files) {
  if (!existsSync(file)) continue;
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example'))
    problems.push(`${file}: environment file must not be tracked`);
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const content = buffer.toString('utf8');
  const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  if (lines > longest.lines) longest = { file, lines };
  if (lines > 1000) problems.push(`${file}: ${lines} lines exceeds 1000`);
  for (const secret of secrets)
    if (content.includes(secret.value)) problems.push(`${file}: contains value of ${secret.name}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))
    problems.push(`${file}: private key material`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Repository check passed: ${files.length} files; longest ${longest.file} (${longest.lines} lines); no configured secrets found.`,
  );
