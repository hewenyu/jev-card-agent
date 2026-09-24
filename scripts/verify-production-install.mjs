import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'jev-production-check-'));
const project = `jev-check-${randomUUID().slice(0, 8)}`;
const execute = (command, args, cwd = directory, capture = false) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    if (capture)
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)),
    );
  });
const compose = (...args) =>
  execute('docker', ['compose', '-p', project, '-f', join(directory, 'compose.json'), ...args]);
let composeCreated = false;
try {
  for (const file of ['package.json', 'package-lock.json'])
    copyFileSync(join(root, file), join(directory, file));
  await execute('npm', ['ci', '--omit=dev', '--ignore-scripts']);
  await execute('node', [
    '--input-type=module',
    '-e',
    "import {SqliteStore,DuelLoop} from 'duelloop'; const s=new SqliteStore(':memory:'); s.close(); if(typeof DuelLoop!=='function') process.exit(1); console.log('Clean production SDK import passed');",
  ]);
  if (!process.argv.includes('--install-only')) {
    writeFileSync(
      join(directory, 'compose.json'),
      JSON.stringify({
        services: {
          app: {
            build: { context: root },
            image: `${project}:local`,
            environment: {
              HOST: '0.0.0.0',
              PORT: '8787',
              READ_ONLY_DEMO: 'true',
              AUTO_START_BOT: 'false',
              DUELLOOP_RESEARCH_ENABLED: 'false',
              DATABASE_PATH: '/app/data/verify.sqlite',
            },
            ports: ['127.0.0.1::8787'],
            volumes: ['verify:/app/data'],
          },
        },
        volumes: { verify: {} },
      }),
    );
    composeCreated = true;
    await compose('build', '--no-cache', '--pull');
    await compose('up', '-d');
    const address = String(
      await execute(
        'docker',
        ['compose', '-p', project, '-f', join(directory, 'compose.json'), 'port', 'app', '8787'],
        directory,
        true,
      ),
    ).trim();
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://${address}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok && (await response.json()).status === 'ok') {
          healthy = true;
          break;
        }
      } catch {
        /* Wait for application startup. */
      }
      await delay(1000);
    }
    if (!healthy) {
      await compose('logs', '--tail', '100');
      throw new Error('Isolated image failed health check');
    }
    const overview = await fetch(`http://${address}/api/overview`).then((r) => r.json());
    if (overview.runtime.running || overview.runtime.mode === 'live')
      throw new Error('Expected an idle synthetic runtime');
    const page = await fetch(`http://${address}/`).then((r) => r.text());
    if (!page.includes('id="root"')) throw new Error('Frontend build was not served');
    console.log(
      JSON.stringify({
        productionInstall: 'passed',
        composeStartup: 'passed',
        frontend: 'passed',
        arenaConnected: false,
      }),
    );
  }
} finally {
  if (composeCreated) await compose('down', '--volumes', '--rmi', 'local').catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
