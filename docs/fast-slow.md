# Fast decisions and asynchronous knowledge / 快慢双循环

> 1.3.0 adds the independently configured async LLM advice layer; see [async research](async-llm.md) for off/shadow/live, immutable archives, private publication and three-database backup. Earlier deterministic-only descriptions below document the retained statistics path.

## Design contract / 设计合同

This document is written before implementation. Acceptance results will be recorded separately in `verification.md`; the design is not a claim of measured latency or profitability.

本文先于实现。目标是纯 Jev 实时选择动作，独立慢循环维护确定性对手统计和审计；当前不调用 LLM 研究。慢循环停止、落后或失败不能阻止有效 Jev 决策。完整历史、费用账本和实际模型请求保留。

### Fast path / 实时路径

Server events update live state continuously. Each action freezes table, hand, turn authority, relevant state, legal candidates and the existing absolute deadline. Local code computes only deterministic facts required by Jev. Normal operation uses one Jev action question; provider failures retain up to three retries within the original deadline. An already persisted answer is resent with the same action ID. There is no local substitute action.

每手固定已发布知识，包括策略版本、历史对手证据、证据事件水位和内容哈希。绑定持久化并覆盖重连和重启；当前牌面和本手行动继续更新。首次恢复到缺少绑定的旧手时，只能使用在该手开始前已发布且适用的知识，或明确记录基础版本，不能引入恢复后新发布的信息。

Hand pins are immutable and independent of process/run restarts. Only knowledge published before the pin's admissible hand boundary may be used. Opponent identity remains the public name, not a verified account identity. Unavailable, expired or incompatible evidence is omitted with a recorded reason, never fabricated.

### Slow path / 慢循环

A separate worker thread reads the raw SQLite database read-only and writes a separate derived knowledge database. It does not receive provider or Arena credentials. Batches have fixed limits and durable cursors. Derived writes must not take the raw event database's write lock. Completed-hand materialization and rolling opponent aggregation happen here, not during `decide()`.

Random-range equity simulations are asynchronous audit additions, bound to the frozen decision ID and input hash. They never mutate the saved decision context or appear as information Jev had at decision time. Queue progress is durable; restarting may recompute unfinished work idempotently. Raw history is never deleted to control queue size.

只自动发布确定性统计。策略资料修改必须有版本、适用范围和验证证据。预留 `ResearchProvider`、`KnowledgeValidator`、`KnowledgeStore` 职责；研究提案不能提交牌桌动作。迟到旧任务不得覆盖新发布。普通手、盈利手和亏损手均保留，不以单手结算直接给动作贴正确性标签。

### Evidence and replay / 证据与复盘

Knowledge records include source, rules/context versions, evidence event watermark, completion/receipt cutoff, publication time, optional expiry, validation and immutable content hash. Historical replay uses the saved hand pin and actual request; experiments using later knowledge are separate counterfactual evaluations, without attributing the original profit to a new action.

Keep current-hand observations separate from completed-hand historical statistics. Sample denominators, missing prices, capped windows and selected-showdown bias remain visible. The public read-only UI shows the pinned knowledge, asynchronous audit status and stage timings without credentials or controls.

### Timing and acceptance / 性能与验收

Measure local receipt to action send and ACK separately from provider latency: snapshot/fact preparation, knowledge selection, provider attempts, durable recording, send and ACK. An absolute decision deadline includes preparation and retries; a speed target does not shorten platform validity or reset time on reconnect.

Acceptance must cover worker disabled/crashed/backlogged, independent database writes, immutable same-hand pins, restarts/resync, stale answers, publication/evidence cutoffs, bounded batches, idempotent cursor recovery, no synchronous audit in decisions and existing provider retries. Run lint, format, types, relevant tests, build, repository size/secrets checks and browser regression tests. Measure performance on representative historical snapshots; report distributions and sample counts, not invented speedups.

Profitability is assessed separately with settled chips, bb/100, sample size, opponent composition and failure rates by version. Engineering checks and offline action changes do not establish profitability.

### Delivery / 交付

Update both READMEs and operational instructions. GitHub builds uncached multi-architecture images. Stop after the current hand, verify departure through the official API, back up and manually update using Docker Compose. Preserve all historical rows and ledgers; verify the public UI, worker progress and new Jev actions after deployment.
