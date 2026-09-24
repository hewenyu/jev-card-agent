# DuelLoop: real OpenPoker history as a shadow domain

## Contract before implementation

This PR consumes the public [DuelLoop SDK](https://github.com/hewenyu/DuelLoop) at
commit `4bd7e9b` (tag `v0.2.0`). It evaluates the framework on this application's
recorded 6-max No-Limit Hold'em decisions. The existing WebSocket runtime retains
execution ownership. The experiment neither joins a table nor publishes strategy
to the running bot.

The question is concrete: can DuelLoop consume the facts and priced candidates
actually sent to Jev, call its Score adapter, persist a versioned decision, and
produce useful, inspectable comparisons with the recorded Choice decisions?

## Data and execution

1. Prepare a frozen plan from a read-only SQLite transaction. Select accepted Jev
   decisions from completed live hands with archived request state and matching
   candidate IDs. Record exclusions, source IDs and content hashes. Never rebuild
   historical context with today's opponent memory or knowledge.
2. Convert archived visible state and priced candidates into a `DomainDefinition`.
   The domain has no execution or counterfactual evaluation capability. Historical
   deadlines are replaced by an explicitly labelled replay computation deadline;
   source timestamps stay in the plan.
3. Run `DuelLoop.decide()` in shadow mode with `executionOwner: 'host'`. Its real
   `JevDecisionModel` supplies candidate Score answers; an application wrapper
   preserves an initial request plus at most three retries and the shared deadline.
   Authentication/model identity errors and cancelled runs do not retry. No local
   action replaces a failed model result, including single-candidate decisions.
4. Persist strategy/release bindings, per-hand pins, observations, answers,
   normalized utilities, selection probabilities and failures in an independent
   DuelLoop SQLite store. Persist provider attempts separately from decisions so
   a failed attempt remains inspectable. Only after all decisions are recorded may
   original hand outcomes be attached as historical feedback, once per hand.
5. Export an aggregate report with legality, original-choice agreement, ties,
   latency, provider usage and failure counts. Full plans, requests and responses
   belong under ignored `data/`; public evidence contains aggregate measurements.

The starting strategy has one holistic ordinal chip-quality rubric. It does not
pretend Score levels are calibrated chip EV, poker equity or a GTO mixed strategy.
Equal scores use the SDK's documented candidate-order tie break. Archived model
inputs retain the original advice and opponent evidence; the report must label
the source data accordingly rather than claim all samples were unassisted Jev.

## What this evaluates

This is a posthoc shadow experiment on real observations, not an Arena match or
an alternative-action profit backtest. Agreement with the original Choice is
descriptive, not correctness. Original hand profit belongs only to the actually
played trajectory and is never assigned as reward to a new shadow action.

The full `ResearchOrchestrator` requires an independent `EvaluationAdapter` and
enforces research token/call budgets. This project currently has neither a
qualified counterfactual 6-max evaluator nor a monetary budget gate. It will not
claim that replay supplies either. The PR will document concrete SDK integration
findings rather than fabricate a profitable, automatically validated release.

DuelLoop is not published on npm and its Git tree does not include `dist/` or a
`prepare` script. A pinned, MIT-licensed `npm pack` archive will be consumed as a
development dependency with source provenance and an integrity digest. Builds
must work from a clean checkout without the sibling `~/code/github/DuelLoop`.
The web server and Docker production dependencies do not import this experiment.

## Acceptance

- Actual SDK imports use only `duelloop`, never private source paths.
- Preparation and offline tests need no credentials and cannot open Arena sockets.
- Invalid plans, future outcome leakage, credential-bearing configuration,
  unsuccessful model results and expired deadlines are rejected and tested.
- Frozen plans and source history are immutable; each replay uses a new output
  directory. Failed runs retain their ledger and terminate without invented actions.
- Run the repository checks and existing browser regressions. A bounded real-model
  run on recorded production data documents actual timing and adapter behavior.
- Update both READMEs and open a new PR; deployment is outside this PR request.

## Reproduce the experiment

Requires Node.js 24 and a normal `npm ci` including development dependencies.
Use an existing local history database or a consistent backup. Never copy an
active SQLite main file without its WAL or use this command to start another bot.

```sh
npm ci
npm run duelloop -- --help

# Reads a live run in a SQLite snapshot, without model requests or raw writes.
npm run duelloop -- --op prepare --database data/jev.sqlite \
  --run-id RUN_ID --limit 24 --output data/duelloop/plan.json

# Exercises the real SDK on this plan with explicitly synthetic Score answers.
npm run duelloop -- --op fixture --plan data/duelloop/plan.json \
  --output data/duelloop/fixture-run

# Calls Jev using the server-side JEV_* values in the local ignored .env.
npm run duelloop -- --op run --plan data/duelloop/plan.json \
  --output data/duelloop/real-run --allow-paid
```

`--model` overrides `JEV_MODEL` (default `jev-1.13.0`). `JEV_BASE_URL` accepts
the same root or `/v1` URL as the existing bot; `JEV_TIMEOUT_MS` defaults to
10,000. `--decision-timeout-ms` defaults to 40,000 for the whole decision,
including at most three retries. These are operational deadlines, not monetary
budget gates. This historical run has no current Arena action authority.

Preparation scans at most 10,000 decisions in the specified run and reports
whether that bound was reached. It samples round-robin across streets, without
looking at profit, then restores chronological order. The default is 24 decisions;
`--limit` accepts 1–1,000. It excludes incomplete hands, unsuccessful/non-Jev actions,
missing or corrupt archived requests, mismatched candidate prices and unsupported
visible-state formats. Source timestamps accept OpenPoker's offset and microsecond
format. Input hashes detect accidental modification; they are not digital signatures.

Every output location must be new. A model failure saves the stopped decision,
sets remaining samples to `not_run`, writes the report and returns a failing exit
code. Starting a new experiment is explicit. SIGINT/SIGTERM cancels the in-flight
request; a cancelled request remains a counted call with unknown usage until a
late result can be separately observed.

Private output files:

| File                 | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `plan.json`          | Frozen inputs, source identities, hashes and separate historical outcomes          |
| `duelloop.sqlite`    | Actual SDK strategies, releases, hand pins, decisions, feedback and snapshot       |
| `requests.jsonl`     | Attempt IDs durably written before each model call                                 |
| `attempts.jsonl`     | Per-attempt status, usage, request hash and latency                                |
| `late-results.jsonl` | Created only for responses arriving after cancellation; never authorizes an action |
| `report.json`        | Full results and framework dependency bindings                                     |
| `summary.json`       | Aggregates suitable for review after checking the source labels                    |

Original outcomes use a separate `historical:` trajectory namespace with no
shadow `decisionId`. They are attached only after the decision pass and are not
valid evaluation rewards for the shadow policy. The report summarizes terminal
attempt records at generation time; late usage is excluded and stays in the
separate append-only ledger. Keep all complete artifacts
under ignored `data/`. No new public controls or environment secrets are required.

## Measured use of the real SDK

On 2026-09-24 UTC, the experiment consumed a previously captured production
database: 94 source decisions, one incomplete-hand exclusion, and 93 eligible
requests. A deterministic street sample selected **24 decisions from 12 hands**,
six on each street, recorded on 2026-09-22 between 09:39:42 and 10:18:14 UTC.
**21 inputs already contained approved asynchronous advice.** This is not a fresh
pure-Jev-without-advice trial. The new calls used `jev-1.13.0` through the actual
DuelLoop `JevDecisionModel`, not a mock or a reimplementation of Score transport.

| Measurement                             | Observed result        |
| --------------------------------------- | ---------------------- |
| Successful / legal selections           | 24 / 24                |
| Failed / retried calls                  | 0 / 0                  |
| Agreement with recorded Choice          | 21 / 24 (87.5%)        |
| Tied best scores                        | 0                      |
| Jev requests / expanded Score questions | 24 / 173               |
| Shadow decision P50 / P95 / maximum     | 728 / 2,215 / 3,126 ms |
| Model-attempt P50 / P95                 | 722 / 2,210 ms         |
| Recorded original Choice P50 / P95      | 335 / 538 ms           |
| Reported input / output tokens          | 266,913 / 3,370        |

The original latencies came from a different machine and time. Their comparison
does not isolate the cost of Score versus Choice. The expanded question count
does show why adding many overlapping Score dimensions would increase input size.
One dimension still supplies all candidate scores in one request per decision.

The three disagreements provide concrete review cases:

| Street | Hero / board           | Recorded Choice | Shadow Score |
| ------ | ---------------------- | --------------- | ------------ |
| Turn   | Qc Jc / 5d Jh 3c 2s    | call            | fold         |
| River  | Ad Ah / Kc Ac Qs 5d Ks | check           | raise to 150 |
| River  | Jd Jc / 8d 4d Qd 4c Ks | call            | fold         |

The second case shows the framework expressing a value-betting alternative with
a full house. The two folds identify disagreement about continuing ranges and
price. These descriptions are not outcome-based correctness labels; only the
recorded actions were actually played. See the [public aggregate evidence](verification/duelloop-shadow.json).

## Framework findings

- The public SDK is usable as a host-owned shadow decision engine for real NLHE
  inputs. Strategy identity, per-hand release binding, candidate scores and
  stopped records are available without editing DuelLoop.
- The SDK only consumes Score strategies. Existing Choice behavior cannot be
  migrated unchanged; a strategy comparison is required. Ties select the first
  supplied candidate, so candidate order is part of the behavior contract.
- The upstream Jev adapter disables retries. The application wrapper supplies
  three retries, a shared deadline, durable start/finish records and safe late
  usage handling. These settings are included in its behavior digest.
- The public root entry eagerly loads pi dependencies. Installing it as a dev
  dependency and invoking it only in this CLI avoids loading them in the web
  server or current live fast loop. The archive reproduces byte-for-byte from
  the pinned public commit; SHA-256 is
  `99dc235067698eea1faf4e3b04e1208c332ff84ac69edc7c0ae8c03b65e41114`.
- No `ResearchOrchestrator`, pi research team, DeepSeek call, automatic release
  publication, real match or counterfactual profit evaluation is claimed here.
  A defensible 6-max evaluator and the research budget-policy mismatch remain
  concrete integration gaps for a full DuelLoop strategy-improvement loop.

The new tests exercise actual SDK storage/runtime plus controlled model responses:
read-only history, visible-state integrity, priced candidates, single-action model
calls, strategy pins, cancellation, retry accounting, source outcome isolation
and CLI configuration. The real-model run above is separate from offline tests.

`npm run check` passed 677 unit/integration tests plus lint, formatting, TypeScript,
build, file-length and secret checks. All 64 Playwright tests passed. A clean
temporary development install loaded the public SDK and opened its SQLite store;
a separate `npm ci --omit=dev` could not resolve DuelLoop and successfully started
and closed Fastify. Production was not deployed by this experiment.
