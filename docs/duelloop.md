# DuelLoop: live decisions, research and historical replay

The 2.0.0 refactor promotes DuelLoop from the PR #6 shadow experiment to the
application’s live Score decision and strategy lifecycle. OpenPoker execution
remains host-owned. This document describes the branch implementation; it does
not claim this version is deployed.

The production dependency is the official public-source SDK **0.2.2** release package, without
private source imports. [Package provenance](../vendor/README.md) pins the source
commit, archive hashes and reproduction command. Clean production installs include
DuelLoop and require no sibling checkout.

## Live integration

`src/poker/` defines the shared six-max domain, visible features, priced legal
candidates and reviewed initial strategy. `src/duelloop/live/` owns one SDK entry
point. `src/duelloop/host/` connects SDK intent/receipt/feedback to the host’s durable
execution journal. The runtime continues to own the WebSocket, lease and final
send guard; the SDK does not poll or independently submit an action.

SDK 0.2.2 supplies per-decision cancellation, separate model/action deadlines,
pre-decision trajectory pinning, receipt event deduplication and first-settlement
research triggers. Natural cancellation ends the affected task; model/storage
failure retains explicit failure handling. The shared real model adapter makes an
initial request plus at most three bounded retries, validates actual model
identity and records incomplete usage without a fictitious zero dollar charge.

Hand start fixes both strategy release and historical facts. Restoration uses the
same bindings; unknown or missing original binding evidence blocks that hand.
Current cards and bets continue changing. New strategy activation/rollback affects
future hands, while an unknown earlier execution blocks the corresponding stream.
The host never substitutes a locally selected action.

The baseline strategy uses a single holistic chip-quality Score rubric and argmax
with documented tie-breaking. Scores are ordinal; provider confidence is distinct
from SDK selection probability, poker equity and chip EV. The persisted trace
contains the actual score request, questions, answers, release and facts identities.
Legacy Choice/advice archives remain readable without pretending they were Score
requests.

## SDK-owned slow loop

The isolated research worker assembles `ResearchOrchestrator` and `ResearchWorker`
with a real DeepSeek Messages provider and the independent poker evaluator. Single
mode uses one provider across SDK roles. Tools inspect frozen evidence, register
behavior fixtures, request development evaluation and submit candidates; they
cannot read final holdout seeds or call Arena/operator endpoints.

The worker receives only explicit model configuration and an empty environment;
it has no Arena execution key. New completed hands trigger research; revisions do
not count as new independent hands. Durable recovery does not replay interrupted
remote work. Missing/invalid protocol files yield `waiting_protocol` without a
restart loop or live-play dependency.

Only eligible independent final validation can create a pending research release.
The default activation mode is `automatic_after_validation`. Before pinning a new
hand, the host activates an eligible validated release through the SDK; existing
hand bindings remain fixed. `explicit` and `candidate_only` are configurable.
Authenticated activation and rollback also use the SDK’s dependency/eligibility
checks and retain an operator audit. See [activation contract](research-auto-activation.md). Public
visitors can inspect status and pending references, not publish a strategy.
Research pause, active-run cancellation, activation pause and Bot stop are separate.

See [research assembly](duelloop-research-refactor.md), [application controls](framework-application-integration.md)
and [independent evaluator](poker-evaluation.md). SDK resource limits cover time,
tokens and calls; there is no monetary admission gate. Unknown tokens can prevent
further research calls, while unknown dollar cost remains an accounting limitation.

## Formal protocols and private seeds

Use `npm run research -- --op prepare-protocols` with explicitly chosen sample
count, hands per seed, improvement/regression thresholds, confidence and latency
limit. It generates fresh disjoint seeds in ignored private files and refuses to
overwrite them. The formal generator rejects fewer seeds than the chosen minimum;
it does not infer statistical power from a small integration diagnostic.

The default paths are `data/protocols/development.json` and
`data/protocols/final.json`. Review and lock the protocol before looking at final
results. A final holdout has one permitted use; configure a new independent
protocol rather than repeatedly selecting against the same held-out deals.
Changing thresholds after observing final results invalidates that experiment’s
interpretation. Sample units are paired seed blocks, not individual model calls.

## Historical shadow tool

The original replay CLI remains isolated from the live store and scope. It reads
completed accepted Jev decisions with archived visible inputs and matching priced
candidates, freezes a plan and records exclusions. It does not join a table, publish
a release or assign historical profit to alternative actions.

```sh
npm run duelloop -- --help
npm run duelloop -- --op prepare --database data/jev.sqlite \
  --run-id RUN_ID --limit 24 --output data/duelloop/plan.json
npm run duelloop -- --op fixture --plan data/duelloop/plan.json \
  --output data/duelloop/fixture-run
npm run duelloop -- --op run --plan data/duelloop/plan.json \
  --output data/duelloop/real-run --allow-paid
```

Preparation and fixture mode need no model credentials. Real run uses private
`JEV_API_KEY`, `JEV_BASE_URL`, `JEV_MODEL` and timeout settings. Each output path must
be new. Replay replaces the already expired historical deadline with an explicitly
labelled computation deadline; source timestamps remain immutable. Trusted archived
nested evidence is not independently authenticated by the replay reader.

The first historical SDK 0.2.0 experiment completed 24 choices, matched 21 recorded
actions and measured 728 ms P50 / 2,215 ms P95. Those measurements remain historical
and are not reassigned to SDK 0.2.2. The 0.2.1 audit work is described in
[audit fixes](duelloop-audit-fixes.md).

## Current real-model evidence

On 2026-09-24, four paired Choice/Score cases with frozen visible state, candidates
and guidance agreed on three actions. This is a protocol probe, not proof of
behavioral equivalence or a test of every new facts feature.

The independent evaluator made 36 real Jev requests across two paired seed blocks
and twelve simulated hands, comparing identical strategy content in separately
executed branches. Its result was **inconclusive**: too few independent samples,
no demonstrated improvement and no demonstrated group non-regression. A positive
point difference from two blocks does not establish an improved strategy.

DeepSeek completed one controlled read-only tool round in 1,494 ms over two HTTP
requests. No Arena action or strategy publication occurred. Complete usage,
measurement methods and unperformed production checks are in the
[refactor verification report](duelloop-refactor-verification.md).

## Verify and operate

```sh
npm run check
npm run test:e2e
node scripts/verify-duelloop-package.mjs
```

Unit/integration checks cover cancellation, deadlines, hand bindings, unknown
execution, deduplicated receipts, recovery, research isolation and no fallback.
Browser checks cover current Score evidence and retained Choice/advice history.
Real probes are recorded separately from fixture results. Production rollout is
manual Compose work after hand completion and backup; see [deployment](deployment.md).
