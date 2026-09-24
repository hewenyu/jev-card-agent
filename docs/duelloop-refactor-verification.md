# DuelLoop 2.0.0 refactor: verification and limitations

Date: 2026-09-24. Application baseline: merged 1.4.3 commit
`96db76540f2bb48f6eb35d15a426f78c8bf0dd1d`. Target version: 2.0.0.
The SDK provenance is maintained in [vendor/README.md](../vendor/README.md).
This report distinguishes implementation, local evidence and operations not
performed. This change is being delivered as a PR; production was not updated.
The sanitized [machine-readable evidence summary](verification/duelloop-production.json)
records versions, measured probes and aggregate verification results.

This report records the pre-audit implementation at `20222b8`. Follow-up fixes
and their current verification are recorded in [v2 audit corrections](duelloop-v2-audit-fixes.md).
The real evaluator diagnostic below predates the session contract correction and
does not validate the corrected evaluator.

## Result

The branch routes live actions through one DuelLoop Score coordinator, pins
release and historical facts per hand, preserves host-owned action authority and
journals, and assembles SDK research with an isolated DeepSeek provider and an
independent six-max evaluator. Explicit activation/rollback and public read-only
projections are implemented. Legacy decisions remain readable.

**Profitability is not established.** The real evaluator diagnostic returned
`inconclusive`; its two independent seed blocks are insufficient for the configured
statistical gate. A small positive mean difference is not an accepted improvement.
No production release was activated as a result of these probes.

## Real Jev Choice/Score protocol probe

Four archived visible observations were evaluated twice using exact
`jev-1.13.0`: Choice and Score saw frozen state, candidate identities and guidance.
This probe isolates the protocol change; it does not validate every new live facts
projection or reconstruct past decisions using new historical evidence.

| Measurement              | Observed result               |
| ------------------------ | ----------------------------- |
| Paired observations      | 4                             |
| Matching selected action | 3 / 4                         |
| Choice elapsed times     | 2,400 / 441 / 452 / 469 ms    |
| Score elapsed times      | 1,364 / 479 / 449 / 675 ms    |
| Score attempts           | 4 successful initial attempts |
| Selection                | argmax                        |
| Profitability evaluation | Not performed by this probe   |
| Complete dollar cost     | Unknown, not zero             |

Agreement is descriptive, not correctness or equivalence. All alternate actions
remain hypothetical; archived profit is not assigned to them. Exact private
records are retained under ignored local review data. Public documentation does
not include source hand/player identities, keys or complete observations.

## Real independent evaluator diagnostic

The diagnostic compared identical baseline/candidate strategy content in
separately executed branches against the versioned `mixed-v1` opponent suite.
There were two independent paired seed blocks, three hands per branch per block:
twelve simulated hands and 36 real Jev calls. The experiment checks the independent
execution/model/accounting path; it is not a tuned candidate profitability trial.

| Measurement                        | Observed result        |
| ---------------------------------- | ---------------------- |
| SDK validation stage               | Development diagnostic |
| Independent sample count           | 2 paired seed blocks   |
| Real Jev calls                     | 36                     |
| Input tokens                       | 349,626                |
| Output tokens                      | 4,732                  |
| Complete token accounting          | Yes                    |
| Complete dollar cost               | Unknown                |
| Baseline mean reward               | −163.33 bb/100         |
| Candidate mean reward              | −155.00 bb/100         |
| Paired mean difference             | +8.33 bb/100           |
| Reported lower confidence bound    | −97.55 bb/100          |
| SDK candidate decision-compute P95 | 1,330.46 ms            |
| Result                             | **inconclusive**       |

Reasons were `insufficient_independent_samples`, `improvement_not_demonstrated`
and `group_non_regression_not_demonstrated`. Identical strategy content can produce
different real-model answers across separately executed requests. Neither the point
difference nor the negative sample reward estimates proves long-run performance.
No final holdout was consumed and no profitable release is claimed.

The latency above is the SDK report’s candidate decision-compute P95. It is not
WebSocket end-to-end latency, action acknowledgment latency or a production SLO.

## Real DeepSeek Messages tool probe

Exact `deepseek-flash`, thinking disabled, executed one allowlisted read-only
fixture tool and returned `no_change`. It completed two HTTP requests in **1,494
ms**, reporting **893 input tokens** (including cache input categories) and **34
output tokens**. Dollar cost was not completely reported and remains unknown.

This verified the dedicated Messages envelope, exact model identity, tool-use/tool-
result continuation, usage normalization and final structured output. It did not
access a live table, publish advice, run a full strategy research cycle or invoke
an operator action. Later transport-hardening tests use deterministic fixtures;
this earlier real probe is not represented as a rerun after every code change.

## Local verification actually run

The final combined application checks completed on 2026-09-24:

| Check                                    | Result and scope                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                          | Passed: lint, formatting, TypeScript, 858 tests across 103 files, production build and repository checks                                         |
| Complete browser regression              | 65 Playwright tests passed in 26 seconds                                                                                                         |
| Repository constraints                   | 415 inspected files; longest source file 996 lines; no configured secrets detected                                                               |
| SDK tests and package gate               | 239 upstream tests and independent package installation passed                                                                                   |
| SDK public-source reproduction           | Final 0.2.2 archive reproduced byte-for-byte: source `422e24832919a3d72a2936272365e4c827178ec2`, 173,239 bytes; full digest in vendor provenance |
| Real isolated worker lifecycle           | Booted without Arena/model calls; durable pause survived stop/restart and resumed correctly                                                      |
| Missing evaluation protocol              | Research reported `waiting_protocol`; no failing worker restart loop                                                                             |
| Public configuration and legacy archives | Example config and anonymous archive/API coverage passed within the complete suite                                                               |
| Production artifact checks               | Final clean production install and Compose `--no-cache --pull` build passed; SDK import, HTTP health, idle runtime and frontend verified         |
| Migration and Compose management         | Four migration tests and 27 management tests passed                                                                                              |
| Synthetic complete release lifecycle     | Candidate submission → final validation → explicit approval → next-hand pin → rollback passed                                                    |
| Durable live request accounting          | Atomic request/result ledger writes and interrupted unknown-usage recovery passed                                                                |

Research tests exercise original plus three retries, malformed final JSON,
Retry-After cancellation, exact identity, late response accounting without tool
execution, SDK recovery without replaying paid work, first-settlement triggers,
private evidence exclusion and explicit approval delegation. Browser checks keep
legacy historical assertions and verify new pending-release refresh, distinct
Score/provider confidence, unknown cost, mobile containment and no public writes.

The combined release test uses actual application coordinator, domain, research
engine, SDK submission/validation lifecycle and release controls. Independently
constructed research and live dependency identities match. A release stays pending
until approval, existing hand pins survive both approval and rollback, and later
hands pick the new active release. Its model and evaluation rewards are explicitly
**synthetic fixtures**; a passed fixture report verifies lifecycle wiring, not
real model quality or poker profitability. The real evaluator diagnostic above
remains inconclusive.

Live model request/result auditing and usage-ledger updates now share transactions.
A request interrupted before a durable result is recovered as
`PROCESS_INTERRUPTED` with unknown usage; it is not assigned zero tokens or zero
cost. This is separate from the provider's late-result accounting.

Framework refresh uses the SDK's read-only `scopeSummary` and bounded pending-run
queries. It no longer asks a frequently refreshed public projection to enumerate
all historical releases or perform activation-mode writes. Controller regression
tests cover no historical-release scan and settled writers before maintenance
backup. Deterministic audit attachments on new framework decisions are also
returned by the history query layer, with dedicated query regressions.

These are local checks on the combined implementation, distinct from CI results
on the PR's exact commit. The final production image check ran without an Arena
connection and removed its temporary Docker resources afterward. SDK package tests
and provenance are maintained independently in
[vendor/README.md](../vendor/README.md).

## Source cleanup audit

The following observations come from current imports, constructors, configuration
validation and route registration, not just directory names:

| Boundary                        | Finding                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Real server and standalone Bot  | Controller constructs `LiveDecisionCoordinator`; real requests accept Jev only                                   |
| Old synchronous policy selector | Located in `evaluation/legacy/providers.ts`; used by authenticated offline evaluation, not real action execution |
| Old runtime decision pipeline   | Moved to the explicit legacy offline implementation; real runtime consumes the framework coordinator             |
| Statistics                      | Production starts `FactsService`; it cannot publish strategy or submit an action                                 |
| LLM strategy lifecycle          | Production starts `DuelLoopResearchService`; SDK owns run/release transitions                                    |
| Legacy advice archive           | `ResearchMonitor` opens `AdviceStore` with `readOnly:true`; `GET /api/research` is labelled legacy               |
| Old queue/engine/service source | Retained for offline/historical regression; production controller does not instantiate them                      |
| Retired live configuration      | `ASYNC_LLM_*`, `LLM_ADVICE_*`, `LLM_RESEARCH_*`, `REASONING_MODE`, `HYBRID_TIMEOUT_MS` explicitly rejected       |
| Public interface                | New fields use explicit allowlists; SDK private run data, prompts and credentials are excluded                   |
| Research protocol secrets       | Final artifact stored privately; SDK researcher goal/tools do not expose final seeds or holdout ID               |

This is not a claim that every old source file was deleted. Shared pure functions,
legacy types, archived record readers and offline comparisons intentionally remain.
Some old configuration fields remain in the internal AppConfig for offline
compatibility, but their production publishing path is disabled/rejected. Review
must preserve this distinction rather than using file count as the migration test.

The audit found that the old backup script omitted the new facts/framework stores
and that retired `LLM_RESEARCH_*` values could initially be silently ineffective.
Both code issues were corrected: live configuration now rejects the retired
prefix, `.env.example` contains current controls and has a parsing regression
test, and management backup includes facts/DuelLoop databases plus private
development/final protocol files with matching copy-path validation. Recovery of
the complete backup still needs verification against the final deployment
artifacts before rollout; [deployment](deployment.md) makes that an explicit
prerequisite.

## Operations not performed by this PR work

- No replacement of the production container, real Arena session or active release.
- No clearing of production hand, decision, account or usage history.
- No statistical certification of profitability or automatic strategy activation.
- No claim that the independent scripted opponent population represents every
  opponent or an equilibrium solution.

Production rollout must finish the current hand, confirm official departure,
preserve complete backups, verify schema/recovery and then observe actual accepted
Jev actions. Public HTTP health, passing tests and a successful image build are
separate from that operational evidence.
