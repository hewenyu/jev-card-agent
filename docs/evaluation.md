# 评估、测试与费用控制

本文描述已实现的评估口径和验收方法。实际执行结果见 [verification.md](verification.md)，运行命令见 [running.md](running.md)。本项目连接 OpenPoker.ai WebSocket V2，不实现扑克服务器，不通过 webhook 参加对局。

## 三种证据

| 证据                             | 可以回答                                       | 不能回答                       |
| -------------------------------- | ---------------------------------------------- | ------------------------------ |
| 单元、协议集成、API 与浏览器测试 | 合法动作、恢复、预算、数据和页面是否按约定工作 | 模型能否长期盈利               |
| 冻结历史输入的决策重跑           | 新旧策略选项是否一致、耗时、失败和估算成本     | 替代行动的实际收益或 EV        |
| 真实 Arena Run                   | 自动对局是否完整、动作是否确认、已结算筹码变化 | 小样本中的收益是否来自模型优势 |

默认 `npm test` 和 `npm run test:e2e` 不调用收费 API、不进入 Arena。真实调用通过 `diagnose`、`bot`、显式选择模型的 `evaluate` 或控制台操作触发。

## 真实 Run 与回放

SQLite 保存 Run、协议事件、手牌、冻结决策上下文、候选、模型建议、实际提交和确认、checkpoint、对手统计及费用账本。每个动作有独立 `client_action_id`；重试使用相同 ID 和完全相同 payload。`sent`、`accepted`、`rejected` 和 `unresolved` 分开记录。

回放只展示所选决策当时冻结的公共牌、自己底牌、座位和历史；最终结算在单独的位置显示。首手中途加入、恢复中缺少起始状态等情况标记历史不完整，不补造过去信息。对手统计使用当时快照，不把后来公开的牌或当前画像倒灌给历史决策。

Jev 的概率与 confidence 是模型对给定候选的输出，**不是扑克胜率、EV 或已经验证的混合策略频率**。规则 baseline 是可检查的启发式策略，不宣称 GTO。程序只在生成的合法候选集合中比较行动，不代表遍历全部下注金额。

## 收益口径

每手净收益为可靠起始筹码与 `hand_result.final_stacks` 的差值。后续买入和 rebuy 不计入已结算手牌收益。缺少起始历史或跨越两个策略 Run 的未完成手牌保留记录，但 `profit=null`，不参与净收益和 bb/100；界面显示缺失状态。

`bb/100 = 100 × 平均值(每手净筹码 / 该手大盲)`。Run 手数包含观察到的结束手牌，收益指标只使用可核对的完整手牌，因此两者可能不同。演示数据有明确 `demo` 标记，不能汇入真实 `live` 统计。

控制台展示观测收益和样本量，没有统计显著性或盈利保证。官方排行榜链接到 OpenPoker；本地收益不是官方赛季 score。

## 决策重跑

```sh
npm run evaluate -- --demo --run demo-jev --strategy baseline --limit 8
npm run evaluate -- --run RUN_ID --strategy jev --limit 10
REASONING_API_FORMAT=messages npm run evaluate -- --run RUN_ID --strategy jev-reasoning --limit 2
```

每次评估从原记录读取冻结 context 与候选，不修改真实 Run。结果保存独立 ID、原 decision ID、新旧候选、成功/失败、平均延迟和估算成本。界面 Experiments 可查看和创建这些报告。

纯 Jev 每个样本调用一次 Jev。组合策略让 Jev 同时选择合法行动并判断是否需要分析；不需要则结束，需要则调用 Responses 或 Messages，再交给 Jev 重新选择。全链路受总 deadline 和逐调用预算限制，推理失败保留首次合法 Jev 选择。推理模型只能提供分析，不能直接向牌桌提交动作。

重跑结果只统计选项一致数、错误数、延迟与费用；不会把原牌局结算赋给替代策略。不同 Run 的真实收益可以并列查看，但公开 Arena 的时段、对手和牌序不受控，不能据此做因果归因。

## API 协议与模型一致性

- Jev：`POST https://api.typesafe.ai/v1/systemone`，固定请求 `jev-1.13.0`，Choice 必须属于候选，概率项齐全且有效，总和容差 1%，choice 与最高概率一致。
- Responses：配置 `/v1` base URL 后调用 `/responses`，保存请求和返回模型名，拒绝静默模型替换。
- Messages：调用 `/messages`，使用 `x-api-key`、`anthropic-version` 和 adaptive thinking，保存最终分析文本及 usage，不保存隐藏推理内容。
- 代理返回的模型名只能证明接口所报告的身份，不能独立审计其底层模型。

当前实测曾出现请求 `gpt-6-astra` 而代理返回 `gpt-5.6-luna`。协议 HTTP 成功不等于 GPT-6 验证成功；严格校验将该结果标记为 `model_mismatch`。Claude Messages 探针请求和返回均为 `claude-opus-5`。完整记录见验证文档。

## 费用账本

公开 Jev 价格为输入 $0.042 / 百万 token、输出免费。纯 Jev 在付费调用前按其最大 64k 输入预留费用，响应提供 usage 后结算。输入字节上限限制上下文大小；预算不足时不发付费请求，转为合法 fallback。

组合策略由 `LedgerMeter` 对 route、analysis、reconsider 各自预留和结算，避免一次组合调用只计一次费用。未知、取消或未返回 usage 的请求保留预留金额，不假定免费。已返回 usage 的失败/模型不一致响应仍计费。账本保存在 SQLite，重启不会清零。

Responses/Messages 的费率使用 `REASONING_INPUT_PRICE_PER_MILLION`、`REASONING_OUTPUT_PRICE_PER_MILLION`，默认仅是参考估算，必须按所用供应商账单调整。代理可能加入额外输入或采用不同计价；本地 token 估算不是供应商美元硬上限。Overview/Run 成本包含已知费用和未知请求预留；单决策费用来自其关联调用，尚未关联的取消请求仍留在 Run 账本中。

`TOTAL_BUDGET_USD` 是**同一个数据库**中全部 Run 和 evaluation 的累计上限，`RUN_BUDGET_USD` 是新 Run/评估默认上限。复制或改用数据库不会共享预算；部署同一 Bot 应持续使用同一数据库。模型预算耗尽后可以继续使用本地 fallback，手数和时间限制决定何时结束测试。

## 自动化验证范围

| 层       | 主要验证行为                                                                               |
| -------- | ------------------------------------------------------------------------------------------ |
| Core     | Reducer、合法候选、raise-to 边界、信息截止、对手统计和去重                                 |
| Policies | Jev 结构/概率校验、超时、异常、Responses/Messages、严格模型匹配、路由与再次选择            |
| Runtime  | 自动入队、唯一行动权、合法 fallback、迟到取消、重复消息、断线/resync、幂等重发、停止和恢复 |
| Storage  | 冻结数据、记录关联、缺失历史、结算/买入隔离、预算预留、取消计费、重启和租约                |
| Server   | 查询/控制、鉴权、跨站请求保护、只读演示、评估持久化                                        |
| Browser  | 真实构建+Node服务+SQLite的 Overview、Replay、Decision、Experiments，移动端和鉴权状态       |

所有版本控制文本文件不超过 1000 行。`npm run check` 执行 lint、格式、类型、测试、构建和行数/本地凭据扫描；浏览器验证单独运行 `npm run test:e2e`，CI 执行两者。

## 真实 Arena 验收方法

有界测试采用纯 Jev、单个 Bot 连接、独立本地验证数据库，计划最多 30 分钟并观察至少 10 手完成。第二次实际运行 24 分 49 秒，因开始服务器迁移而在手牌边界停止；不将其记作 30 分钟持续验收通过，实际结果见验证报告。核对已接受/拒绝/未决动作、fallback 原因、缺失历史、费用和正常离桌。真实运行期间不启动第二个同账号 WS 客户端。

断线、超时、ACK 丢失和恢复错误主要通过本地可控协议测试验证；自然运行中没有发生的故障，不宣称已经在生产环境实测。合成演示、接口探针与真实对局分别报告。短期输赢不设为工程验收阈值。

## 官方依据

- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe API](https://docs.typesafe.ai/api) 与 [Models](https://docs.typesafe.ai/models)
- [OpenPoker Message Types](https://docs.openpoker.ai/api-reference/message-types/)
- [OpenPoker State Consistency](https://docs.openpoker.ai/building-bots/state-consistency/)
- [OpenPoker Reconnection](https://docs.openpoker.ai/building-bots/reconnection-idempotency/)
