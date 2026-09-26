import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.js';
import { rebindJevRetry } from '../duelloop/host/retry-maintenance.js';

const { values } = parseArgs({
  options: {
    'expected-release': { type: 'string' },
    evidence: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});
if (!values['expected-release'] || !values.evidence)
  throw new Error('--expected-release and --evidence are required; writes require --apply');
try {
  const result = await rebindJevRetry({
    config: loadConfig(),
    expectedRelease: values['expected-release'],
    evidence: values.evidence,
    apply: values.apply,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch {
  // Arbitrary provider configuration, report contents and database text remain private.
  process.stderr.write(
    'Jev retry maintenance failed; keep writers stopped and inspect the private maintenance inputs.\n',
  );
  process.exitCode = 1;
}
