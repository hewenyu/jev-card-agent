# Observatory read performance / 公开页面读取性能

## Problem and acceptance / 问题与验收

The September 22 production investigation measured 4.8–16.9 seconds for the local 42-byte health response and about 35 seconds for browser startup. The HTTP main thread was busy executing synchronous knowledge refreshes. Selecting current support facts scanned 2,043 historical snapshots with an unindexed correlated query, taking about 1.4 seconds per call. Timer and worker progress notifications repeated that work. These are individual observations, not latency percentiles.

9 月 22 日线上只读排查发现：本机健康接口需要 4.8–16.9 秒，页面首次加载约 35 秒。策略支持事实查询在 2,043 条历史快照上重复嵌套扫描，单次约 1.4 秒；定时器和 worker 通知重复触发同一同步工作，阻塞网页与运行事件。以上为单次观测，不代表 P95。

## Read model / 读取结构

- Preserve immutable evidence and historical admission boundaries. Maintain indexed current support references and use indexed history for older cutoffs; never substitute future evidence into an old hand.
- Reuse prepared results while their source revision and validity window are unchanged. New facts, withdrawals, mode changes and expiry must invalidate them. A timer heartbeat alone is not a data change.
- Coalesce worker notifications, separate knowledge publication from public status refresh, and avoid recomputing identical snapshots for each viewer.
- Produce the dashboard data needed for the selected view in one response. Preserve public read-only access, server-authoritative funding/score, cursor pagination, and complete historical detail.
- Refresh only visible data. Completed hand details are stable; live updates and current funding continue to refresh. Collapsed diagnostic details should not repeatedly serialize large input objects.

保留不可变历史，增量维护可索引的当前支持事实；历史截止查询仍按当时可用证据读取。相同数据版本只构建一次结果，撤回、过期、模式与证据变化会使缓存失效。合并重复通知，拆开知识发布与展示状态刷新。首页按当前视图一次返回需要的数据，减少不可见页面的读取，并保留官方账户积分、完整历史与实时更新。

## Verification and release / 验证与发布

Regression checks cover existing database migration, out-of-order support facts, historical cutoffs, withdrawal/expiry, unchanged-revision reuse, funding updates and visible-tab refresh. Measure old and new queries on the same frozen evidence, then verify production health, API latency and browser startup after release. Do not claim a percentile from a single request.

验证旧库迁移、乱序支持事实、历史截止、撤回/过期、重复读取复用、资金实时性与页面切换；使用同一份冻结证据对比查询，再核对线上健康、API 与浏览器。执行项目 lint、格式、类型、测试、构建、浏览器及仓库检查。

Publish the image with the existing cache-disabled GitHub workflow. Update manually with Docker Compose after the current hand finishes and official departure is confirmed. Preserve all three databases, keys, research settings and historical records. No database cleanup is part of this repair.

沿用 GitHub 无缓存镜像发布，人工执行 Compose 更新；等待当前手结束、官方确认离桌后再替换容器。保留三份数据库、密钥、研究配置及全部历史，不清库。

## Frozen production-evidence comparison / 冻结线上证据对照

At `2026-09-22T17:21:55Z`, the read-only benchmark copied 2,043 support snapshots covering 35 scopes into one in-memory SQLite database on the production host. The previous query took **277.19 ms**, the indexed current-head query **0.89 ms**, and the read-model migration **7.53 ms**. Both selected exactly the same 35 IDs. This is one query measurement per implementation on identical frozen rows; it excludes HTTP, original disk reads, bundle validation and browser rendering. It is not production P95. Reproduce with the [benchmark script](read-performance-benchmark.md).

在上述 UTC 时间，只读固定线上 2,043 条支持快照、35 个 scope，在同一内存副本上比较，旧查询 **277.19 ms**，当前指针查询 **0.89 ms**，迁移 **7.53 ms**，返回 35 条 ID 完全一致。每种算法仅测一次，不包含原库磁盘读取、完整 bundle 校验、HTTP 或页面渲染，不把它当作线上 P95。

Other inspected paths now use indexed run-scoped grouping, a covering decision-statistics index, committed source-revision caches, and a light dashboard projection. Research status and unchanged knowledge validation reuse their prepared result. Transaction rollback cannot publish cached uncommitted advice; a completed replay still reloads when late cards or settlement change its summary. Full immutable evidence stays available on demand.

其他已核对路径包括按 Run 聚合、决策统计覆盖索引、已提交数据版本缓存及轻量 dashboard。研究状态与未变化知识不重复解析校验。事务回滚不会留下未提交建议缓存；已完成复盘遇到迟到的牌面或结算补全仍会重新读取。完整不可变证据继续按需访问。

Local verification: **571 unit/integration tests and 63 browser tests passed**, together with lint, formatting, TypeScript, build, secret scanning and the 1,000-line file limit. The final lightweight dashboard projection also passed its focused consistency and permission regressions. Deployment latency is measured separately after the image rollout.

本地验证：**571 项单元/集成测试、63 项浏览器测试通过**，lint、格式、类型、构建、密钥扫描与单文件 1,000 行限制均通过。最终轻量 dashboard 另通过一致性及权限专项回归；线上响应耗时在镜像更新后单独核对。
