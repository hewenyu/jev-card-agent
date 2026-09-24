# Architecture: DuelLoop live poker and asynchronous research

This document describes the 2.0.0 refactor against the merged 1.4.3 baseline
`96db76540f2bb48f6eb35d15a426f78c8bf0dd1d`. It describes code and contracts, not a
claim that this branch has been deployed. See [verification](duelloop-refactor-verification.md).

## Ownership

| Responsibility                                                                 | Authority                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Game rules, matching, legal action authority, settlement and official score    | OpenPoker                                                           |
| WebSocket, current state, account reconciliation, lease, actual action sending | Host runtime                                                        |
| Visible poker facts, legal priced candidates and stable identities             | Application poker domain                                            |
| Strategy, release, trajectory binding, Score decision and research lifecycle   | DuelLoop Store and runtime                                          |
| Completed public opponent statistics and delayed mathematical audits           | Isolated facts service                                              |
| Research proposals and independent candidate evaluation                        | SDK research worker with DeepSeek and Jev                           |
| Explicit activation/rollback                                                   | Authenticated host control using SDK validation and boundary checks |
| Raw history, application execution journal and public read models              | Application storage                                                 |

The public browser is a spectator. There is one real Bot process per account and
persistent store. SDK `start()` does not independently poll the same stream; the
host drives one SDK decision when an authorized Arena turn arrives.

## Modules

```text
src/
  core/                  reducer, legal actions and deterministic poker calculations
  poker/                 shared domain, visible projection and reviewed initial strategy
  runtime/               WebSocket authority, leases, deadlines, sending and acknowledgment
  duelloop/live/         Score coordinator, persistent hand bindings and model adapter
  duelloop/host/         execution journal, outbox, receipts and settled feedback
  duelloop/research/     SDK assembly, DeepSeek tools, isolated worker and release controls
  duelloop/              retained independent frozen-history replay tools
  facts/                 deterministic evidence snapshots and asynchronous audits
  evaluation/poker/     independent six-max simulator and versioned opponent suites
  evaluation/legacy/    explicitly offline Choice/Hybrid comparisons
  storage/               raw history, migration, indexed queries and historical decoders
  server/                private controls, public projections, SSE and static files
  shared/                public application contracts without SDK private artifacts
web/src/                 public statistics, live table, history and decision evidence
```

Existing `knowledge/*` and `research/*` contain historical contracts, read helpers
and legacy offline implementations. The production controller does not instantiate
the old knowledge/advice publishing services. Importing pure card definitions,
legacy types or historical decoders does not give them a live publishing path.

All maintained text files stay below 1,000 lines. TypeScript is strict; CI checks
lint, formatting, types, unit/integration tests, build, file limits and credential
hygiene. Tests normally use synthetic models and WebSockets.

## Fast loop

1. Reduce each authoritative server event into current state. Freeze a decision
   observation using table/hand/actor/turn identity and priced legal candidates.
   Connection-only changes and waiting-player notifications do not alter decision
   membership; genuine changes to chips, participation or action authority do.
2. Persist original hand facts and pin the SDK release at hand start, or restore
   the original binding. Facts include historical cutoff and digest. Cross-store
   interruption cannot authorize rebuilding old facts from newer information.
3. Use `DuelLoop.decide(observation, candidates, {signal, modelDeadline})` with the
   shared audited real Jev Score adapter. The strategy contains its own questions,
   weights and selection rule. Mutable legacy advice is not hidden in features.
4. Obtain and persist a host execution intent, write the application command and
   check current lease, connection generation, turn identity, legal amount and
   authority deadline again immediately before sending.
5. Send using the SDK decision/idempotency identity. Persist raw acknowledgment and
   outbox before delivering a normalized SDK receipt. Record settlement feedback
   only with corresponding raw evidence.

`observation.deadline` is the original action authority. The model cutoff is a
separate absolute time that includes local preparation and submission reserve;
reconnect or retry never starts a fresh action window. The model wrapper checks
its deadline after synchronous durable writes as well as through AbortSignal.

Jev is the only live action model. Initial requests may retry at most three times;
transient errors use bounded exponential backoff and sanitized Retry-After.
Authentication, identity and storage errors do not blindly retry. No valid model
result means no locally selected check/fold. Natural task cancellation cannot
execute a late result; genuine failure produces an explained persistent stop.

## Execution and recovery

SDK intent and host journal are separate persistent authorities. Neither alone
proves an action was sent or completed. Recovery reconciles prepared, sent,
accepted, rejected and unknown states. An accepted receipt can remain unresolved
until environment evidence establishes completion. Receipt event IDs deduplicate
repeated delivery and conflicting payloads remain errors.

An application outbox can retry delivery to SDK without retrying the real-world
bet. Unknown execution blocks new submission on that stream. Explicit resume
first reconciles the failure/intent rather than silently constructing a new
instance to bypass an unresolved outcome. Model outputs are never moved to a new
turn because an action name happens to remain legal.

## Facts and strategy are different objects

The facts worker reads completed raw evidence with bounded cursors. It does not
hold model or Arena keys and does not publish strategies. Current-hand cards and
bets remain live; historical facts are fixed for the hand. Exact unavailable
facts remain missing. Uniform-random showdown simulations belong to delayed
mathematical audit, not to the actual Jev input or inferred betting-range EV.

A strategy release binds its strategy digest to domain, model and runtime
behavior dependencies. Changes to strategy or behavior require a compatible new
release. Per-hand bindings separately retain release digest and facts digest.
Late publication and rollback affect future unpinned hands; an emergency stop is
required to prevent further actions in an already pinned hand.

## Slow loop and publication

`ResearchWorker` uses `first_settlement`: correcting an earlier hand revises
snapshot evidence but does not manufacture an independent new sample. Its
`ResearchOrchestrator` is the sole research state machine and release registrar.
A single real DeepSeek Messages provider maintains bounded role sessions and
executes only SDK-declared tools. It cannot access shell, files, arbitrary URLs,
Arena actions, operator controls or final holdout seeds.

The separate worker receives an empty environment and an explicit whitelist of
DeepSeek and Jev evaluation settings. Heavy evaluation cannot occupy the live
JavaScript event loop. Every request has a durable start/result reference,
cancellation and usage status; late measured usage is appended separately.
Interrupted paid work is not replayed on recovery. A completed validation can
finish release registration without repeating model calls.

Development and final protocols have disjoint seeds and holdouts. Formal protocols
are created privately from explicit predeclared parameters. The independent
six-max evaluator branches baseline/candidate, calls Jev for each hero decision,
and aggregates paired seed blocks. Its scripted opponent suites are a versioned
experimental population, not a claimed model of every Arena player. Final
validation can pass, fail or be inconclusive; only eligible final validation can
register a research release. Default activation is `explicit`.

Time, token and model-call limits bound resources. There is no dollar budget gate;
unknown costs do not become zero. Unknown token use can terminate research because
the SDK cannot enforce the remaining resource contract. Research failure or
`waiting_protocol` does not stop live play with an existing valid release.

## Persistence and public queries

- Raw SQLite preserves runs, original observations, decisions, commands, account
  events and the host recovery/outbox records.
- Facts SQLite stores derived evidence and asynchronous audits.
- DuelLoop SQLite stores decisions, release bindings, intents, feedback, research
  runs, validation and private protocol artifacts.
- Existing legacy knowledge/research databases remain available for historical
  read compatibility; they are not new release authorities.

All paths remain under persistent storage and must be distinct, including symlink
aliases. Consistent SQLite backups include committed WAL content. Cross-database
backups are individually consistent; no cross-database atomic snapshot is claimed.
Hand bindings/outbox carry the recovery linkage. Private protocol files need backup
too. Updating code never implies clearing history.

Public read models whitelist fields. They never serialize raw SDK task data,
provider credentials or private artifacts. Research history uses bounded SDK SQL
queries and model attempt arrays are released after persistence. Dashboard results
remain indexed and cached by relevant data revisions. Historic Choice/advice
records preserve their old meanings; new Score records explain ordinal grades,
provider confidence, selection probabilities and incomplete usage separately.

The Live tab keeps the table and current-hand decisions first, with facts and
research below. Overview remains statistics-only. Available chips, street bets,
REST account placement and official season score retain separate sources. The
server is authoritative; animations do not calculate balances.

## Delivery and capability limits

This is a PR-only delivery. Production rollout, hand-boundary replacement and
post-deployment evidence remain separate operations. GitHub builds uncached images;
manual Compose updates finish the current hand and verify departure. Public writes
remain blocked by the application and Nginx.

The real-model evaluator diagnostic was inconclusive. Engineering closure, protocol
agreement and short model probes do not establish profitability. Longer locked
experiments and subsequent live observation are required to assess net chips,
bb/100, sample uncertainty and drawdown.
