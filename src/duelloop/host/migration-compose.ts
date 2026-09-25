import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function encodeMigrationEnv(values: Record<string, string>): string {
  const encode = (value: string) => {
    if (!value.includes("'")) return `'${value}'`;
    if (!/["\\$]/.test(value)) return `"${value}"`;
    throw new Error('An environment value cannot be represented losslessly in Node and Compose');
  };
  const text =
    Object.entries(values)
      .map(([key, value]) => `${key}=${encode(value)}`)
      .join('\n') + '\n';
  const decoded = parseEnv(text);
  if (
    Object.keys(decoded).length !== Object.keys(values).length ||
    Object.entries(values).some(([key, value]) => decoded[key] !== value)
  )
    throw new Error('Environment round-trip validation failed');
  return text;
}

/** Standalone service: never merge with the production named-volume configuration. */
export function writeMigrationCompose(output: string, next: Record<string, string>) {
  const containerEnv = {
    ...next,
    DATABASE_PATH: '/app/data/raw.sqlite',
    KNOWLEDGE_DATABASE_PATH: '/app/data/knowledge.sqlite',
    RESEARCH_DATABASE_PATH: '/app/data/research.sqlite',
    FACTS_DATABASE_PATH: '/app/data/facts.sqlite',
    DUELLOOP_DATABASE_PATH: '/app/data/sdk.sqlite',
    DUELLOOP_DEVELOPMENT_PROTOCOL: '/app/data/protocol-development.json',
    DUELLOOP_FINAL_PROTOCOL: '/app/data/protocol-final.json',
  };
  writeFileSync(join(output, '.env.compose'), encodeMigrationEnv(containerEnv), {
    mode: 0o600,
    flag: 'wx',
  });
  const compose = {
    services: {
      app: {
        image: '${JEV_IMAGE:-hewenyulucky/jev-card-agent:2.0.1}',
        init: true,
        user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        restart: 'unless-stopped',
        env_file: '.env.compose',
        environment: { HOST: '0.0.0.0', PORT: '8787' },
        ports: ['127.0.0.1:${CONSOLE_PORT:-18787}:8787'],
        volumes: [
          {
            type: 'bind',
            source: './working',
            target: '/app/data',
            bind: { create_host_path: false },
          },
        ],
        stop_grace_period: '150s',
        healthcheck: {
          test: [
            'CMD',
            'node',
            '-e',
            "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
          ],
          interval: '30s',
          timeout: '5s',
          start_period: '15s',
          retries: 3,
        },
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      },
    },
  };
  writeFileSync(join(output, 'compose.json'), JSON.stringify(compose, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return {
    file: 'compose.json',
    envFile: '.env.compose',
    workingDirectory: 'working',
    containerDirectory: '/app/data',
  };
}
