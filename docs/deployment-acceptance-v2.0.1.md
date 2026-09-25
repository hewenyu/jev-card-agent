# v2.0.1 deployment acceptance / 部署验收

Checkpoint: 2026-09-25 00:54 UTC; session/facts follow-up 00:56 UTC。
主检查点：北京时间 08:54；session/facts 补充核对：08:56。
This is an operational snapshot, not a profitability evaluation.
本文记录部署时的运行证据，不是盈利能力评价。

## Release identity / 发布身份

| Item / 项目                        | Verified value / 已核对值                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Public site / 公开站点             | <https://openpoker.zve.ccwu.cc>                                                              |
| Application / 应用                 | `v2.0.1`, revision `7e7c29c4e90872e8d2db775db61463325d94310f`                                |
| Refactor / 重构                    | [Merged PR #7](https://github.com/hewenyu/jev-card-agent/pull/7), tagged `v2.0.0`            |
| Recovery fixes / 恢复修复          | [Merged PR #8](https://github.com/hewenyu/jev-card-agent/pull/8), tagged `v2.0.1`            |
| SDK                                | [Official DuelLoop v0.2.2](https://github.com/hewenyu/DuelLoop/releases/tag/v0.2.2)          |
| Docker CI                          | [Successful publish run](https://github.com/hewenyu/jev-card-agent/actions/runs/36076246990) |
| Production architecture / 生产架构 | `linux/arm64`                                                                                |

Deployed image / 实际部署镜像：

```text
hewenyulucky/jev-card-agent@sha256:8790f94eed486b5c9ef59ab578e4951592652e8aa407034c294df84b5663e16e
```

## 中文

### 停机原因与修复

旧生产实例因磁盘写满停止正常运行：SQLite 报 `database or disk is full`，
Docker 健康检查执行也报 `no space left on device`。重复备份是主要可回收占用之一：
33 组相同 SQLite 快照同时存在于容器卷和宿主目录，额外占用 9,530,347,520 字节。

先安全完成当前手、确认官方离桌、停止派生写入与旧容器，再逐份校验、去重和归档。
原 66 个备份路径对应的内容压缩为约 1.283 GB，完整旧生产数据库、WAL 和配置另存
为约 1.995 GB 的归档；归档在服务器和本地均已保存、完整核对。没有清空牌局历史。
新的工作副本验收后，移除已归档的旧原始文件，服务器恢复约 15 GiB 可用空间，
磁盘使用率约 68%。

这足以恢复运行，但尚不足以再次运行默认完整备份：当前约 9.675 GiB 的原始库
单库保守检查要求约 20.6 GiB 空闲，其他库和后续增长另计。下一次维护应先扩容，
再排空并备份；直接执行备份会在安全停牌后因容量不足失败。本次旧版本回滚材料
已完整保存，不代表后续新牌局已有持续异地备份。

`v2.0.1` 改用 64 KiB 流读取计算迁移 SHA-256，避免一次性载入超过 10 GB 的库。
备份创建 SQLite 一致快照并执行 `quick_check`，流式压缩后解压核对 SHA-256；
宿主副本核对成功后才删除本次容器临时归档。写入前检查空间并至少保留 1 GiB。
已有备份不会自动删除；容量或验证失败时保持 Bot 已安全停下的状态。

### 数据与部署核对

迁移保留 **17 次运行、4,145 手牌、5,359 条决策、122,160 条事件**。这些是切换前
的校验计数，不包含新版本之后的持续增长。完整旧源快照约 13.927 GB；迁移副本的
八个文件约 13.876 GB，服务器与本地逐文件 SHA-256 一致。旧 facts/SDK 库不存在，
因此创建新库；旧手牌不会被伪造为新 SDK 决策或用于充抵新的研究触发手数。

实际旧 `1.4.3` 镜像已在隔离 Compose 中读取恢复副本，通过分页运行/手牌历史和
决策详情检查；原本为零的待确认动作、无阻塞状态也保持一致。非空阻塞保留由
既有合成迁移回归验证，本次真实副本没有该类样本。新版本预览通过后，先移除预览服务，再替换唯一生产
实例；没有启动第二个真实 Bot。部署根 Compose 现在指向迁移后的工作目录，
容器用户与目标文件属主匹配为 `1001:1001`。Nginx 配置检查通过，保持本机反代。

旧原始主库/WAL 已归档，**不能直接启动旧 named volume 回滚**。必须把配套主库、
WAL 和原私有配置恢复到独立可写目录，用旧镜像验证后切换。
具体规则见[部署手册](deployment.md#备份与回滚)。原始归档、清单、种子和凭据不公开。

### 真实对局与公开站验收

截至检查点，新运行完成 **10 手、20 次 accepted Jev Score 动作**，每次都有模型
调用记录，所有 SDK intent 均已完成。没有持久决策阻塞、重复接受的回合、
同手混用 release/facts、stopped 来源的接受动作或过期未确认提交。
该批次净筹码 **−26**；10 手不足以判断盈利能力。

00:56 UTC 补充检查覆盖五手含多次决策的牌局，其中包含从翻前到河牌的连续行动：
session 顺序递增，前序决策数量匹配，整手使用同一 session、release 和 facts。
11 个结算 feedback、50 个 receipt outbox 条目全部送达，无重试错误。facts 的
结算待处理数为零，审计 cursor 已追平当时最新决策，快照包含 102 个对手；后续
决策已包含相关对手证据。初始决策可能使用回填尚未完成时固定的较早快照，这些
历史输入保持原样。

运行状态为 `playing`，无错误；六个座位、庄家与 Bot 手牌已通过公开数据核对。
Overview 与 Live 共用的官方赛季积分均为 **11,672**，资金状态为 `current`，
离桌余额 9,698、REST 在桌筹码 1,974，auto-rebuy 开启。当前 WS 座位筹码与当街
下注分开显示；本次没有实际触发 rebuy，不将余额同步检查当作 rebuy 实测。

公开健康、汇总、框架和历史接口均返回 200，匿名权限 `canControl=false`。
86 秒跨时间观察中，真实牌桌序号从 891 增至 1,095，并发生换手与结算；另一次
8 秒 SSE 采样收到 18 个快照，真实桌面序号也在增加，验证了数据刷新。
站点资源与对应本地构建哈希一致，包含 OpenPoker 官方牌桌直达按钮和 GitHub 链接。
抽样公开响应未发现凭据字段或常见密钥格式；这不是全部历史的穷尽检查。

容器内汇总/框架约 23 ms，历史列表约 3 ms、详情约 10 ms；公开请求采样约
0.71–1.05 秒。以上是少量单次观测，不能当作 P95 或长期性能承诺。

### 模型、慢循环与验证范围

实时动作使用 `jev-1.13.0`，单次请求超时 10 秒，总决策时限 40 秒，提交预留
1,500 ms；首次调用后最多三次重试，无本地动作兜底。Bot 无手数或时长上限。
facts worker 独立重建确定性证据，历史输入仍按每手绑定，不回填成当时已知信息。

DeepSeek 研究已启用且正在运行，使用 `deepseek-flash`、Messages 端点及关闭 thinking
的配置。新 provider 使用生产凭据的隔离连通性测试成功，耗时 **612 ms**。
生产研究须累计 **100 个新 SDK 结算**后触发，并遵守后续批次/冷却条件；
本检查点尚未触发生产研究，不能把该独立测试称为生产研究结果。

当前 release 来源是 **bootstrap**，尚无独立统计验证；策略激活模式为 **explicit**，
不会因为慢循环返回提案就直接替换线上策略。上线可用性和策略盈利验证分别记录。

发布 CI 的 `npm run check` 通过，包括 **108 个测试文件**；另有 **65 个浏览器测试**
通过。GitHub 无缓存构建并发布双架构镜像，服务器人工使用 Compose 更新。
新备份/迁移回归覆盖大文件流式哈希、真实 SQLite/WAL 和 Compose 归档校验。
本次工具环境无法连接浏览器，因此没有宣称完成部署后的浏览器视觉验收；已完成
公开 HTTP、SSE、页面资源及历史数据核对。

## English

### Cause and recovery

The old instance stopped functioning because the disk was full. SQLite reported
`database or disk is full`; Docker health-check execution also reported
`no space left on device`. The old backup workflow retained 33 identical snapshot
pairs in the container volume and host directory, consuming an extra
9,530,347,520 bytes.

Recovery drained the hand, confirmed official unseated placement, and stopped the
old runtime and derived writers before changes. Every duplicate was verified.
The contents represented by all 66 backup paths were archived into approximately
1.283 GB; the complete old databases, WAL files and configuration were archived
separately into approximately 1.995 GB. Both server and local copies were verified.
Hand history was preserved. Retiring the verified archived source files after
preview acceptance left approximately 15 GiB free, at 68% filesystem usage.

The patch hashes large migration databases using 64 KiB streams. Backups create
consistent SQLite snapshots, run `quick_check`, compress as a stream, and verify
the decompressed SHA-256. Temporary container archives are removed only after
the host copy matches. Capacity guards reserve at least 1 GiB; failures leave the
bot safely drained. Existing archives are not automatically deleted.

The recovered space supports operation but is insufficient for the default full
backup workflow: the approximately 9.675 GiB raw database alone requires around
20.6 GiB free under its conservative capacity check, before other stores and
future growth. Expand backup filesystem capacity before the next maintenance.
Running backup now would drain the bot and then fail the capacity check, leaving
it stopped. The verified rollback archives do not back up subsequent new play.

### Data and deployment

Migration preserved **17 runs, 4,145 hands, 5,359 decisions and 122,160 events**
before new play resumed. The original snapshot was approximately 13.927 GB.
All eight migrated files, approximately 13.876 GB, matched local hashes on the
server. Facts and SDK stores were new; legacy hands were not converted into
fabricated SDK decisions or counted toward the new research trigger.

An isolated Compose restore using the actual old `1.4.3` image passed paginated
history and decision detail checks. Its original zero pending actions and absence
of a blocker were preserved; nonempty blocker preservation was covered separately
by synthetic migration regressions, not this production sample. The preview was removed
before replacing production; only one real bot connected. Root Compose now maps
the migrated working directory, with container UID/GID `1001:1001` matching its
owner. Nginx configuration passed validation. **The old named volume cannot be
started directly for rollback:** restore matching main/WAL files and original
private configuration into a fresh writable directory, then validate the old image.

### Live acceptance

At the checkpoint, the new run had **10 settled hands and 20 accepted Jev Score
actions**, with recorded provider attempts and completed SDK intents. No persistent
decision blocker, duplicate accepted turn, mixed per-hand release/facts binding,
accepted stopped-source action, or expired uncertain send was found. Net chips
were **−26**; this sample is too small to assess profitability.

A 00:56 UTC follow-up checked five hands with multiple decisions, including
preflop-through-river play. Session turns and prior-turn counts advanced in order;
each hand retained one session, release and facts snapshot. All 11 settlement
feedback and 50 receipt outbox entries were delivered without errors. Facts had
no pending settlement results, its audit cursor matched the latest decision, and
the snapshot contained 102 opponents. Subsequent decisions included relevant
opponent evidence. Early hands may retain older snapshots pinned before backfill
caught up; their historical inputs are not rewritten.

The bot was `playing` without an error. Public data included six seats, the dealer
and the bot's hole cards. Overview and Live both showed the official season score
**11,672**, with current funding, available balance 9,698, REST table chips 1,974
and auto-rebuy enabled. Seat stack and street bet are separate fields. No actual
rebuy occurred during this sample.

Public health, dashboard, framework and history returned 200 with anonymous
`canControl=false`. Over 86 seconds, table state sequence advanced from 891 to
1,095 with new hands and settlements. A separate eight-second SSE sample delivered
18 snapshots with advancing table state. Assets matched the local build, including
direct OpenPoker and GitHub links. Sampled responses contained no credential fields
or common API-key patterns; this was not an exhaustive history security review.

Internal dashboard/framework requests took approximately 23 ms; history list/detail
took 3/10 ms. Public samples took approximately 0.71–1.05 seconds. These are individual
observations, not percentile guarantees.

### Models and limits

Live decisions use `jev-1.13.0`, with a ten-second request timeout, a forty-second
decision deadline, 1,500 ms execution reserve, and up to three retries after the
initial request. There is no local action fallback or configured hand/time limit.
The independent facts worker rebuilds deterministic evidence without rewriting
what past decisions knew.

DeepSeek research is enabled and running with `deepseek-flash`, the Messages
endpoint and thinking disabled. An isolated request through the new provider using
production credentials succeeded in **612 ms**. Production research requires
**100 new SDK settlements** and subsequent batch/cooldown conditions; no production
research run had triggered at this checkpoint. The connectivity test is not a
production research result. The active release is **bootstrap**, without independent
statistical validation, and strategy activation remains **explicit**.

Release CI passed `npm run check` across **108 test files**, plus **65 browser tests**.
GitHub published both architectures without cache; the server was updated manually
with Compose. Deployment-time browser control was unavailable, so no fresh visual
browser inspection is claimed. HTTP, SSE, asset and history checks were completed.
