import { argumentsFor, fail } from './args.js';
import { loadConfig } from '../server/config.js';
import { prepareEvaluationProtocols } from './evaluation-protocols.js';

/** Private HTTP control only: never start a second research publisher beside the server. */
async function main(): Promise<void> {
  const args = argumentsFor({
    op: { type: 'string', default: 'status' },
    url: { type: 'string' },
    run: { type: 'string' },
    release: { type: 'string' },
    actor: { type: 'string' },
    reason: { type: 'string' },
    output: { type: 'string' },
    'development-seeds': { type: 'string' },
    'seed-blocks': { type: 'string' },
    'final-seeds': { type: 'string' },
    'hands-per-seed': { type: 'string' },
    'min-samples': { type: 'string' },
    'minimum-improvement': { type: 'string' },
    'max-group-regression': { type: 'string' },
    confidence: { type: 'string' },
    'max-latency-ms': { type: 'string' },
  });
  if (args.op === 'prepare-protocols') {
    process.stdout.write(JSON.stringify(prepareEvaluationProtocols(args), null, 2) + '\n');
    return;
  }
  const config = loadConfig();
  const base =
    typeof args.url === 'string'
      ? args.url
      : `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`;
  const required = (name: string) => {
    const value = args[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
    return value;
  };
  let path = '/api/framework',
    body: unknown,
    method = 'GET';
  const op = args.op;
  if (op === 'pause' || op === 'resume') {
    path += '/research/pause';
    body = { paused: op === 'pause' };
  } else if (op === 'cancel') {
    path += '/research/cancel';
    body = { runId: required('run') };
  } else if (op === 'recover') {
    path += '/research/recover';
    body = {};
  } else if (op === 'pause-activation' || op === 'resume-activation') {
    path += '/activation/pause';
    body = {
      paused: op === 'pause-activation',
      actor: required('actor'),
      reason: required('reason'),
    };
  } else if (op === 'approve' || op === 'rollback') {
    path += `/releases/${op}`;
    body = {
      releaseDigest: required('release'),
      actor: required('actor'),
      reason: required('reason'),
    };
  } else if (op !== 'status')
    throw new Error(
      'Unknown operation. Use status, pause, resume, cancel, recover, approve, rollback, pause-activation or resume-activation. Legacy advice publishing commands are retired.',
    );
  if (body !== undefined) method = 'POST';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`Control request failed (${response.status}): ${JSON.stringify(result)}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
void main().catch(fail);
