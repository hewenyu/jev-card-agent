import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('package-lock.json')) {
  writeFileSync(
    'package-lock.json',
    `${JSON.stringify(JSON.parse(readFileSync('package-lock.json', 'utf8')))}\n`,
  );
}
