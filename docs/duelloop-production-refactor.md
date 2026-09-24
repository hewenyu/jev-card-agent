# DuelLoop production refactor / 完整重构

Status: 2.0.0 implementation, complete application regression gates and clean
production image verification passed.
Delivery is a reviewable PR, not an already deployed production migration.
Application baseline: `96db76540f2bb48f6eb35d15a426f78c8bf0dd1d` (v1.4.3).
SDK baseline: `cba13bb69453f7ea2cd7a79db9d3fbe9859eabc4` (0.2.1).
The implemented SDK is 0.2.2; its exact current public source, archive digest and
reproduction command are recorded in [vendor provenance](../vendor/README.md).

## Assessment / 方案评估

The supplied 2026-09-24 proposal correctly identifies the missing production lifecycle.
PR #6 delivered historical shadow evaluation, not a live migration. Its application SHA
predates the merged release: preserve the v1.4.3 waiting-seat membership and CI fixes.

本轮交付完整快慢循环，不把固定 bootstrap 或 fixture 评价标注成完整策略验证。
实施有以下修正：

- 保留费用、请求、未知用量和迟到结果审计；遵从用户既有要求，不新增金额预算、充值或未知价格准入门槛。
- SDK 先在源仓库补逐次取消、模型/行动双截止、提前手级 pin、回执去重和首次结算触发，再锁定可追溯包。
- 历史事实固定一手，当前牌面/筹码/行动持续更新；不能冻结整手实时状态。
- 策略统一由 SDK release 发布。旧 advice 只能用于历史解释，不再注入新决策。
- 研究进程因真实评价需要 Jev 凭据，但不持有 OpenPoker 执行凭据。公开界面仅有脱敏读模型。
- 独立评价采用明确支持的 6-max 无抽水、无 ante 规则，分别执行 baseline/candidate 分支。
  规则测试、真实模型链路验证和统计盈利证据是三个不同结果，不互相代替。
- 自动研究可配置，当前应用只提供 explicit 策略激活；未开放生产自动激活，旧 auto 配置不静默继承。
- 本次先交付代码、SDK 包、迁移/恢复工具、验证与 PR，不自动替换正在运行的生产容器。

## Ownership / 职责

OpenPoker runtime owns the socket, authority, host lease, final legality check and send.
DuelLoop owns Score decisions, releases, intents, feedback, research and final validation.
The raw application database retains events, original action evidence and history. A separate
DuelLoop database owns framework state. Deterministic facts/audits remain independent of LLM work.

`src/poker/` defines shared facts, candidates, stable identities and reviewed initial strategy.
`src/duelloop/live/` coordinates a single live decision and immutable hand bindings.
`src/duelloop/host/` persists execution links, outbox, receipts and feedback.
`src/duelloop/research/` adapts providers, evaluator, worker isolation and controls to SDK lifecycle.
`src/evaluation/poker/` provides the independent six-player environment and protocols.
Existing historical replay is isolated from live scope and never inherits counterfactual rewards.

## Contracts / 关键契约

Model features exclude authority tokens, credentials, hidden opponent cards, future outcomes,
mutable advice and uniform-equity audit attachments. Strategy instructions belong to the release.
Score is ordinal; selection probability, scoring confidence and poker win rate remain distinct.

At hand start persist the original facts snapshot, then pin the SDK release, then bind the two.
Recovery can complete an interrupted binding only from the saved original facts. Release changes
and rollback affect future hands. Unknown legacy actions continue to block execution.

Before sending, persist the SDK decision, SDK intent and host payload. Use the SDK decision ID
as `client_action_id`. Never regenerate an action because delivery is uncertain. Persist original
ack evidence and outbox atomically, then deliver idempotently. A receipt needs matching ID and
protocol evidence; a later hand alone is not proof of completion.

Cancellation ends only its decision. Fatal model/storage/identity errors retain stop semantics.
Initial attempt plus at most three retries share the original model deadline; retries do not
extend action authority. No live local-action fallback exists.

## Acceptance / 验收

Cover timing/cancellation, visibility, stable pins across restart/publication, six execution crash
windows, duplicate/late receipts, feedback revisions, research recovery and final-validation
publication, old-history readers, retired configuration rejection and public read-only behavior.
Run application `npm run check`, `npm run test:e2e`, SDK `npm test`, `npm run check:package`,
clean production install/image and copied-database migration/restore verification.

Private real-model evidence goes under ignored `data/reviews/`; sanitized verification records
must state exact versions, sample counts, usage completeness and limitations. Production history
is preserved. Every source file remains at most 1,000 lines. This document records
implementation and test boundaries; production migration remains a separate operation.

## Implementation checklist / 原方案任务映射

The original proposal's task numbers are retained for review. “Implemented” below
means source and the stated local tests exist; it does not mean a real production
hand, profitable strategy or recovery from a production backup was verified.

| Task                        | Implementation and evidence                                                                                                                                            | Remaining boundary                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 Baseline / 入口清单     | v1.4.3 merged baseline above; [cleanup audit](duelloop-refactor-verification.md#source-cleanup-audit); original waiting-seat and CI regressions retained               | Real probes use the documented small private sample; no population-level inference                                                          |
| T02 SDK cancellation / time | Public SDK 0.2.2 adds per-decision cancellation, original authority deadline, hand pin, receipt/owner recovery; [host validation](duelloop-host-bridge-validation.md)  | Single active host; uncertain cross-host ownership requires operator reconciliation                                                         |
| T03 Request accounting      | Shared `src/duelloop/live/model.ts` and research provider persist starts, attempts, late results and unknown usage; original attempt plus three retries share deadline | Original proposal's monetary reservation/gate deliberately omitted per user's explicit no-budget requirement; token/call/time bounds remain |
| T04 Domain / facts          | `src/poker/` and `src/facts/` separate visible facts, priced candidates and immutable strategy guidance; no authority or hidden cards in model features                | Supported simulator rules are explicitly six-max no-rake/no-ante                                                                            |
| T05 Hand binding            | `HandBindings` stores original facts before SDK pin and rejects irrecoverable/mismatched bindings; nine pin tests cover publication/reopen/time boundaries             | Current board, bets and stacks continue changing within the same pin                                                                        |
| T06 Stores / migration      | `src/cli/migrate-duelloop.ts`, host journals/outbox and separate raw/facts/SDK stores; migration tests and [migration guide](duelloop-migration.md)                    | Production copy/restore operation not performed                                                                                             |
| T07 Execution recovery      | Thirteen host bridge cases and six actual-runtime WebSocket fixture cases, including two cold database reopens                                                         | Fixture network, not a production Arena soak; no authority deadline extension                                                               |
| T08 Choice / Score          | Four paired real Jev observations; three matching selections; full limitations in [verification](duelloop-refactor-verification.md)                                    | Protocol-only diagnostic, no equivalence or profitability proof                                                                             |
| T09 Runtime / image         | Actual app controller creates only Score coordinator; clean production install and Compose no-cache image checks passed; old advice writer absent                      | Restricted production live acceptance not performed                                                                                         |
| T10 Independent evaluator   | `src/evaluation/poker/` executes independent baseline/candidate branches; rules, side pots, visibility, model failure and independent sample tests                     | Scripted opponents are not a claim of equilibrium or universal exploitability coverage                                                      |
| T11 Evaluation protocol     | Private immutable disjoint development/final artifacts; declared thresholds; paired seed-block unit; shared model/domain/policy dependency identities                  | Real 12-hand diagnostic was inconclusive and did not consume final holdout                                                                  |
| T12 Research lifecycle      | SDK Orchestrator/Worker is the production scheduler; isolated provider; first-settlement trigger; durable cancellation/recovery/pause and waiting_protocol tests       | No real full research-to-profitable-release run claimed                                                                                     |
| T13 Approval / rollback     | Authenticated application controls delegate validated release approval/rollback to SDK; existing hand pins preserved                                                   | Synthetic combined lifecycle test passed; actual production activation not performed                                                        |
| T14 Legacy removal          | Live policy selector retired to `evaluation/legacy`; old workers not instantiated; retired controls rejected; `.env.example` parses under current config               | Archive/offline fixture source intentionally retained; not every old file is deleted                                                        |
| T15 Public compatibility    | New framework/Score read models, legacy Choice/Advice readers, anonymous mutation denials, fixture demo; complete 65-browser-test suite passed                         | Public interface exposes no operator controls or provider credentials                                                                       |
| T16 Install / rollback      | Clean production install, cache-free Compose build; backup includes raw/archive/facts/SDK stores and private protocol files                                            | Real production-volume backup restore and program rollback rehearsal not performed                                                          |
| T17 Sole production graph   | Controller starts `FactsService`, `DuelLoopResearchService`, `LiveDecisionCoordinator`; sole SDK strategy authority; old archive reader is read-only                   | Static graph is supplemented by local runtime tests, not substituted for live operational evidence                                          |
| T18 Full-loop delivery      | Both loops, independent evaluation, explicit release controls, migration/docs/UI assembled in one application PR with upstream SDK PR                                  | Production acceptance and automatic activation are not claimed; automatic activation remains unavailable                                    |

## Verification state / 验证状态

`npm run check` passed: lint, formatting, TypeScript, 858 tests across 103 files,
production build and repository constraints. The longest inspected source file is
996 lines. The complete Playwright suite passed 65 tests. SDK 0.2.2 passed 239
upstream tests and the package gate; the final source archive reproduced
byte-for-byte. Exact provenance is in [vendor/README.md](../vendor/README.md).

Final clean production installation and Compose `--no-cache --pull` image checks
passed, including SDK import, HTTP health, idle runtime and frontend serving.
Temporary Docker resources were removed and no Arena session was started. Four
migration and 27 management tests passed. The synthetic candidate → final
validation → explicit approval → next-hand pin → rollback application integration
test passed. Detailed scope and limitations are in
[the verification report](duelloop-refactor-verification.md).

Real probes used exact `jev-1.13.0` and `deepseek-flash` with complete observed token
usage; monetary costs remain unknown. The independent evaluator's small real
sample was **inconclusive**. There was no production deployment, history reset,
real Arena action, production release approval or automatic strategy activation
as part of this PR work.
