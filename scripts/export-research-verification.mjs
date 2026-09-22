import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const source = 'data/reviews/async-llm-v2';
const target = 'docs/verification';
const isolation = JSON.parse(readFileSync(`${source}/isolation-performance.json`, 'utf8'));
const archive = JSON.parse(readFileSync(`${source}/archive-performance.json`, 'utf8'));
mkdirSync(target, { recursive: true });
// Only numeric timings and controlled environment metadata are published, never stored model inputs.
const fields = [
  'preparationMs',
  'knowledgeMs',
  'providerMs',
  'persistenceMs',
  'sendMs',
  'receiptToSendMs',
  'ackMs',
];
const rows = [['scenario', 'sample', ...fields]];
for (const item of isolation.raw)
  item.timings.forEach((timing, index) =>
    rows.push([item.scenario, index + 1, ...fields.map((field) => timing[field] ?? '')]),
  );
writeFileSync(
  `${target}/async-llm-timings.csv`,
  rows.map((row) => row.join(',')).join('\n') + '\n',
);
const { rawMs, ...refresh } = archive.unchangedControllerRefresh;
writeFileSync(
  `${target}/async-llm-archive.csv`,
  'sample,unchangedRefreshMs\n' +
    rawMs.map((value, index) => `${index + 1},${value}`).join('\n') +
    '\n',
);
writeFileSync(
  `${target}/async-llm-performance.json`,
  JSON.stringify(
    {
      generatedAt: isolation.generatedAt,
      environment: isolation.environment,
      limitations: isolation.limitations,
      scenarios: isolation.summary,
      archive: { ...archive, unchangedControllerRefresh: refresh },
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  `Exported ${rows.length - 1} controlled decision timings and ${rawMs.length} archive refresh samples.\n`,
);
