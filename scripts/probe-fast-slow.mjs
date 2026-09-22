// Offline CPU/storage benchmark. Build first. Never reads credentials or connects to the Arena.
import { copyFileSync, createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildContext, buildCandidates, createInitialState } from '../dist/core/index.js';
import { parseValidActions } from '../dist/core/state.js';
import { candidateCriteria, projectJevState } from '../dist/core/harness.js';
import { estimateUniformEquity } from '../dist/core/poker-cards.js';
import { Store } from '../dist/storage/store.js';
import { baselineSnapshot, KnowledgeStore } from '../dist/knowledge/store.js';
import { snapshotHash } from '../dist/knowledge/validator.js';
import { SlowLoopService } from '../dist/research/service.js';

const source = resolve(process.argv[2] || 'data/reviews/2026-09-21-overnight/snapshot.sqlite');
const runId = process.argv[3] || '2523bf71-54dd-47c2-a46f-1cad2d17f22f';
const directory = resolve('data/reviews/fast-slow', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = {
  createdAt: new Date().toISOString(),
  source,
  runId,
  machine: { platform: platform(), arch: arch(), node: process.version, cpu: cpus()[0]?.model },
  scope: [
    'Offline local CPU and SQLite measurements; no model, network, WebSocket, submission, or ACK latency.',
    'Paired audit comparison adds the old 1,200 uniform samples to identical current deterministic preparation; it is not an executable benchmark of the complete historical release.',
    '256-opponent snapshot and eligible audit backlog are explicitly synthetic workload extensions on isolated private databases.',
    'No speed threshold is asserted; this machine and filesystem do not establish deployment latency or profitability.',
    'Preparation measures JSON snapshot reconstruction, deterministic facts, optional knowledge pin, candidates, projection and serialization; it excludes session-history retrieval, receipt persistence, decision/action persistence and transport.',
  ],
};
function summarize(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const q = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    samples: values.length,
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    maxMs: sorted.at(-1) ?? 0,
    meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
  };
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const originalHash = await fileHash(source);
const sourceDb = new DatabaseSync(source, { readOnly: true });
sourceDb.exec('PRAGMA query_only=ON;');
const rows = sourceDb
  .prepare(
    "SELECT id,context,created_at FROM decisions WHERE run_id=? AND status='accepted' AND source='jev' ORDER BY created_at,id",
  )
  .all(runId);
const findTurn = sourceDb.prepare(
  "SELECT payload FROM events WHERE table_id=? AND hand_id=? AND seq=? AND type='your_turn' ORDER BY id LIMIT 1",
);
for (const row of rows) {
  const context = JSON.parse(row.context);
  const turn = findTurn.get(context.tableId, context.handId, context.lastTableSeq);
  if (!turn) throw new Error(`No original your_turn for ${row.id}`);
  row.turn = String(turn.payload);
}
sourceDb.close();
if (!rows.length) throw new Error('No accepted Jev decisions in the requested run');

function restoreState(row) {
  const context = JSON.parse(row.context);
  const turn = JSON.parse(row.turn);
  return {
    ...createInitialState(),
    ...context,
    actorSeat: context.heroSeat,
    validActions: parseValidActions(turn.valid_actions),
    turnToken: turn.turn_token,
  };
}
function prepare(row, { audit = false, store, handId } = {}) {
  const state = restoreState(row);
  if (handId) state.handId = handId;
  const context = buildContext(state, [], { asOf: row.created_at, recentOutcomes: [] });
  if (store) {
    const binding = store.pinKnowledge(state, new Date().toISOString());
    const names = new Set(
      state.seats
        .filter((seat) => seat.seat !== state.heroSeat && seat.inHand !== false && !seat.folded)
        .map((seat) => seat.name),
    );
    const { opponents, cards: _cards, ...snapshot } = binding.snapshot;
    context.opponentMemory = opponents.filter((opponent) => names.has(opponent.name));
    context.knowledge = {
      snapshot,
      pin: { ...binding.pin, opponentMemory: context.opponentMemory },
    };
  }
  if (audit) {
    const opponents = state.seats.filter(
      (seat) =>
        seat.seat !== state.heroSeat &&
        seat.name &&
        seat.inHand !== false &&
        !seat.folded &&
        !['empty', 'sitting_out'].includes(seat.status),
    ).length;
    context.harness.uniformShowdownReference = estimateUniformEquity(
      state.holeCards,
      state.board,
      opponents,
      { samples: 1200 },
    );
  }
  const candidates = buildCandidates(state);
  const input = JSON.stringify({
    state: projectJevState(context),
    options: candidateCriteria(context, candidates),
  });
  return {
    inputCharacters: input.length,
    state,
    auditSamples: context.harness.uniformShowdownReference?.samples ?? 0,
  };
}
function measure(fn) {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}
for (const row of rows.slice(0, 20)) {
  prepare(row);
  prepare(row, { audit: true });
}
const paired = [];
for (const [index, row] of rows.entries()) {
  // Alternate order to reduce a systematic warm-cache advantage.
  let fast;
  let withAudit;
  if (index % 2) {
    withAudit = measure(() => prepare(row, { audit: true }));
    fast = measure(() => prepare(row));
  } else {
    fast = measure(() => prepare(row));
    withAudit = measure(() => prepare(row, { audit: true }));
  }
  paired.push({
    id: row.id,
    street: JSON.parse(row.context).street,
    fastMs: fast.ms,
    withAuditMs: withAudit.ms,
    auditSamples: withAudit.value.auditSamples,
    inputCharacters: fast.value.inputCharacters,
  });
}
report.history = {
  sampleSelection: 'Every accepted Jev decision in the fixed run; same rows in both arms.',
  warmupPairs: Math.min(20, rows.length),
  deterministic: summarize(paired.map((row) => row.fastMs)),
  completed1200SampleSimulations: paired.filter((row) => row.auditSamples === 1200).length,
  deterministicPlus1200Audit: summarize(paired.map((row) => row.withAuditMs)),
  streetCounts: Object.fromEntries(
    ['preflop', 'flop', 'turn', 'river'].map((street) => [
      street,
      paired.filter((row) => row.street === street).length,
    ]),
  ),
  rows: paired,
};
console.log(
  JSON.stringify({
    stage: 'historical-pairs',
    ...report.history.deterministic,
    withAuditP95Ms: report.history.deterministicPlus1200Audit.p95Ms,
  }),
);

function stressSnapshot() {
  const baseline = baselineSnapshot();
  const { contentHash: _hash, ...content } = baseline;
  const time = '2026-09-01T00:00:00.000Z';
  const earlier = '2026-08-31T23:59:00.000Z';
  const stats = {
    observedActions: 200,
    raises: 40,
    calls: 60,
    checks: 80,
    folds: 20,
    allIns: 0,
    facedBetObserved: 80,
    foldedToObservedBet: 20,
    sizedContributions: 80,
    contributionToPotSum: 40,
  };
  const opponents = Array.from({ length: 256 }, (_, index) => {
    const name = `synthetic-opponent-${index}`;
    const encounters = Array.from({ length: 6 }, (_, encounterIndex) => ({
      handId: `${name}-e${encounterIndex}`,
      tableId: 'synthetic-table',
      completedAt: earlier,
      receivedAt: earlier,
      tableSeq: 42,
      resultEventId: encounterIndex + 1,
      board: ['2h', '3c', '4d', '8s', '9h'],
      shownCards: ['Ac', 'Kd'],
      heroParticipated: true,
      line: Array.from({ length: 8 }, (_, actionIndex) => ({
        seat: actionIndex % 2,
        name: actionIndex % 2 ? name : 'synthetic-hero',
        street: ['preflop', 'flop', 'turn', 'river'][Math.floor(actionIndex / 2)],
        action: 'call',
        amount: 20,
        contribution: 20,
        potBefore: 40 + actionIndex * 20,
        toCallBefore: 20,
        tableSeq: actionIndex + 1,
      })),
    }));
    return {
      version: 'completed-opponent-encounters-v1',
      name,
      asOf: time,
      sampledHands: 200,
      sampleLimit: 200,
      sampleCapped: true,
      firstCompletedAt: earlier,
      lastCompletedAt: earlier,
      shownHands: 3,
      streets: { preflop: stats, flop: stats, turn: stats, river: stats },
      showdowns: encounters.slice(0, 3),
      recentEncountersWithHero: encounters.slice(3),
      caveats: ['Synthetic bounded workload, not observed poker evidence.'],
    };
  });
  const snapshot = {
    ...content,
    source: 'deterministic',
    version: 'synthetic-256-opponents',
    evidenceEventId: 100,
    evidenceCutoff: time,
    publishedAt: time,
    opponents,
    validation: ['Synthetic benchmark-only fixture; never published to a production store.'],
  };
  return { ...snapshot, contentHash: snapshotHash(snapshot) };
}
const stress = stressSnapshot();
const stressKnowledgePath = join(directory, 'stress-knowledge.sqlite');
const stressKnowledge = new KnowledgeStore(stressKnowledgePath);
stressKnowledge.publish(stress);
stressKnowledge.close();
const disabledService = new SlowLoopService(
  join(directory, 'stress-raw.sqlite'),
  stressKnowledgePath,
  { enabled: false },
);
await disabledService.start();
const pinStore = new Store(join(directory, 'stress-raw.sqlite'));
pinStore.knowledgeSource = disabledService;
pinStore.beginRun({
  id: 'performance',
  kind: 'demo',
  strategy: 'jev',
  startedAt: new Date().toISOString(),
  config: {},
});
const pinFirst = [];
const pinRepeated = [];
const pinRecovered = [];
const fixture = restoreState(rows[0]);
fixture.seats = fixture.seats.map((seat) =>
  seat.seat === fixture.heroSeat ? seat : { ...seat, name: `synthetic-opponent-${seat.seat}` },
);
for (let index = 0; index < 32; index++) {
  const state = { ...fixture, handId: `pin-stress-${index}` };
  const now = new Date().toISOString();
  pinStore.appendEvent(
    'performance',
    { type: 'hand_start', table_id: state.tableId, hand_id: state.handId, ts: now },
    now,
  );
  const first = measure(() => pinStore.pinKnowledge(state, now));
  if (first.value.pin.reason !== 'published' || first.value.snapshot.opponents.length !== 256)
    throw new Error('Stress snapshot was not actually selected');
  pinFirst.push(first.ms);
  for (let repeat = 0; repeat < 4; repeat++)
    pinRepeated.push(measure(() => pinStore.pinKnowledge(state, now)).ms);
  const recovered = new Store(pinStore.filename);
  pinRecovered.push(measure(() => recovered.pinKnowledge(state, now)).ms);
  recovered.close();
}
report.pinStress = {
  source:
    'Synthetic 256 opponents, each capped at 200 hands, six examples of eight actions; real file-backed Store and disabled SlowLoopService.',
  snapshotBytes: Buffer.byteLength(JSON.stringify(stress)),
  firstHandPin: summarize(pinFirst),
  sameHandMemoryRead: summarize(pinRepeated),
  reopenedStoreHandRecovery: summarize(pinRecovered),
  timingExcludes:
    'Store construction and hand_start event append. First pin includes source snapshot clone, validation, raw SQLite persistence and immutable freeze.',
};
pinStore.close();
await disabledService.stop();
console.log(
  JSON.stringify({
    stage: 'pin-stress',
    firstP95Ms: report.pinStress.firstHandPin.p95Ms,
    cachedP95Ms: report.pinStress.sameHandMemoryRead.p95Ms,
  }),
);

const backlogRawPath = join(directory, 'backlog-raw.sqlite');
copyFileSync(source, backlogRawPath);
const backlogStore = new Store(backlogRawPath);
// Only this disposable copy is modified. Original historical decisions did not use this new knowledge.
backlogStore.db
  .prepare(
    "UPDATE decisions SET context=json_set(context,'$.knowledge',json(?)) WHERE run_id=? AND status='accepted' AND source='jev'",
  )
  .run(JSON.stringify({ pin: { knowledgeVersion: 'benchmark-only' } }), runId);
backlogStore.beginRun({
  id: 'performance',
  kind: 'demo',
  strategy: 'jev',
  startedAt: new Date().toISOString(),
  config: {},
});
const slow = new SlowLoopService(backlogRawPath, join(directory, 'backlog-knowledge.sqlite'), {
  enabled: true,
  intervalMs: 5,
  batchSize: 4,
});
backlogStore.knowledgeSource = slow;
const statuses = [];
slow.on('update', () => statuses.push(slow.status()));
await slow.start();
for (let attempt = 0; !slow.status().lastCompletedAt && attempt < 1000; attempt++) {
  if (slow.status().error) throw new Error(slow.status().error);
  await delay(10);
}
if (!slow.status().lastCompletedAt) throw new Error('Worker did not produce a bounded batch');
const backlogAtStart = slow.status();
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const drift = [];
let lastTick = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  drift.push(Math.max(0, now - lastTick - 10));
  lastTick = now;
}, 10);
const underBacklog = [];
try {
  for (const [index, row] of rows.entries()) {
    const state = restoreState(row);
    const handId = `backlog-probe-${index}`;
    const now = new Date().toISOString();
    backlogStore.appendEvent(
      'performance',
      { type: 'hand_start', table_id: state.tableId, hand_id: handId, ts: now },
      now,
    );
    underBacklog.push(measure(() => prepare(row, { store: backlogStore, handId })).ms);
    await delay(5);
  }
} finally {
  clearInterval(timer);
  histogram.disable();
  report.workerBacklog = {
    workload:
      'Copied frozen raw history; 519 copied decisions explicitly marked audit eligible. Worker generates statistics and 1,200-sample audits in bounded batches on its own thread/database.',
    localPreparation: summarize(underBacklog),
    interval10msExcessDelay: summarize(drift),
    eventLoopHistogram: {
      resolutionMs: 10,
      p50Ms: histogram.percentile(50) / 1e6,
      p95Ms: histogram.percentile(95) / 1e6,
      maxMs: histogram.max / 1e6,
    },
    initial: backlogAtStart,
    final: slow.status(),
    progressMessages: statuses.length,
    observedBacklogDuringMeasurement: statuses.some(
      (status) => status.pendingHands > 0 || status.pendingAudits > 0,
    ),
    timingExcludes:
      'Event append, initial raw-file copy and migrations; timer drift still includes foreground event appends and first-hand knowledge publications.',
  };
  await slow.stop();
  backlogStore.close();
}
report.sourcePreserved = {
  beforeSha256: originalHash,
  afterSha256: await fileHash(source),
  bytes: statSync(source).size,
};
if (report.sourcePreserved.beforeSha256 !== report.sourcePreserved.afterSha256)
  throw new Error('Source snapshot changed during probe');
const output = join(directory, 'performance.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(
  JSON.stringify({
    report: output,
    sourcePreserved: true,
    history: report.history.deterministic,
    auditComparison: report.history.deterministicPlus1200Audit,
    firstPin: report.pinStress.firstHandPin,
    workerBacklog: report.workerBacklog.localPreparation,
    timerDrift: report.workerBacklog.interval10msExcessDelay,
  }),
);
