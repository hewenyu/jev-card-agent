# 评估、测试与费用记录

本文描述已实现的评估口径和验收方法。实际执行结果见 [verification.md](verification.md)，运行命令见 [running.md](running.md)。本项目连接 OpenPoker.ai WebSocket V2，不实现扑克服务器，不通过 webhook 参加对局。

## 三种证据

| 证据                             | 可以回答                                           | 不能回答                       |
| -------------------------------- | -------------------------------------------------- | ------------------------------ |
| 单元、协议集成、API 与浏览器测试 | 合法动作、恢复、费用记录、数据和页面是否按约定工作 | 模型能否长期盈利               |
| 冻结历史输入的决策重跑           | 新旧策略选项是否一致、耗时、失败和估算成本         | 替代行动的实际收益或 EV        |
| 真实 Arena Run                   | 自动对局是否完整、动作是否确认、已结算筹码变化     | 小样本中的收益是否来自模型优势 |

默认 `npm test` 和 `npm run test:e2e` 不调用收费 API、不进入 Arena。真实调用通过服务器的 `diagnose`、`bot`、显式选择模型的 `evaluate` 或受保护内部 API 触发；公开网页只读。

## 真实 Run 与回放

SQLite 保存 Run、协议事件、手牌、冻结决策上下文、候选、模型建议、实际提交和确认、checkpoint、对手统计及费用账本。每个动作有独立 `client_action_id`；重试使用相同 ID 和完全相同 payload。`sent`、`accepted`、`rejected` 和 `unresolved` 分开记录。

回放只展示所选决策当时冻结的公共牌、自己底牌、座位和历史；最终结算在单独的位置显示。首手中途加入、恢复中缺少起始状态等情况标记历史不完整，不补造过去信息。对手统计使用当时快照，不把后来公开的牌或当前画像倒灌给历史决策。

按所有者要求，Live 也展示 Bot 自己的当前手牌、本手已保存决策及分析。每手是独立 session，每次行动有独立 turn/decision ID；实时显示和历史复盘采用同一已保存证据，未返回的思考内容明确标记缺失，不虚构分析。公共展示不包含未公开的对手底牌、行动授权或鉴权凭据。

Jev 的概率与 confidence 是模型对给定候选的输出，**不是扑克胜率、EV 或已经验证的混合策略频率**。规则 baseline 是可检查的启发式策略，不宣称 GTO。程序只在生成的合法候选集合中比较行动，不代表遍历全部下注金额。

## 当前数据收集与后续 harness 对照

本次复盘后的更新保留全部 Run、手牌、决策、行动、原始事件、资金记录及费用账本，不清库。新版以新 Run、代码修订和上下文版本区分；旧版已发生的 fallback 保留为历史事实，不归入新合同的 Jev 决策样本。原始备份及详细复盘报告保存在私有目录。

当前重点是数据采样：本轮使用 `BOT_STRATEGY=jev`，不在收集期间自动改写策略，实际运行时长与样本量需单独核实。保留已记录的完整原始协议事件、每手 session、冻结决策输入、候选、行动确认、结算与费用账本。模型实际输入保持有界，不将完整历史数据库逐次发送，也不因上下文裁剪删除数据库历史。自动启动不限制手数和时长，开启 auto-rebuy。模型请求受行动 deadline 约束，不作金额限制。每个提交动作必须来自 Jev；无有效结果时保存失败并持久停牌，重启不会自动恢复，须通过私有管理入口显式恢复。

成功的 Jev 请求保存原请求，以及通过 schema 解析后的 `model`、`usage`、`answers`。该结构不是逐字 HTTP 响应档案；schema 未保留的额外字段不属于完整保留承诺。失败调用仅保留 attempts、状态及可取得的部分诊断，不能假定能够重建全部失败请求/响应正文。数据分析须区分成功的结构化输出与失败记录。

数据积累后再复盘。后续向 harness 注入总结、对手习惯或策略规则，应保存明确版本及来源，使用同一组冻结输入、相同信息截止和合法候选对照原策略，分别报告选项差异、延迟、失败和成本；旧版样本另列 fallback 来源。注入后产生的新 Run 要与原版本分开统计；不得把之后的结果泄漏到原决策输入，也不得用原行动收益替代新行动的反事实收益。当前没有自动在线学习或盈利保证。

## 收益口径

每手净收益为可靠起始筹码与 `hand_result.final_stacks` 的差值。后续买入和 rebuy 不计入已结算手牌收益。缺少起始历史或跨越两个策略 Run 的未完成手牌保留记录，但 `profit=null`，不参与净收益和 bb/100；界面显示缺失状态。

`bb/100 = 100 × 平均值(每手净筹码 / 该手大盲)`。Run 手数包含观察到的结束手牌，收益指标只使用可核对的完整手牌，因此两者可能不同。演示数据有明确 `demo` 标记，不能汇入真实 `live` 统计。

控制台展示观测收益和样本量，没有统计显著性或盈利保证。官方排行榜链接到 OpenPoker；本地收益不是官方赛季 score。

## 按实际决策来源归因

不能仅按 Run 的 `strategy=jev` 判断每个动作都由 Jev 选择。旧版 Run 会包含服务失败和金额门槛触发的本地 fallback；复盘按每手已接受决策来源拆为全部 Jev、全部 fallback、混合及无需动作四组，同时报告全部结果。`Win rate` 是正收益手数 / 可核实结算手数，零收益弃牌仍在分母；不是摊牌胜率，Jev 候选概率也不能代替它。

2026-09-21 15:26:02 UTC 的旧版一致快照有 955 手可核实结算、50 手盈利，净 -3,590 筹码。196 手全部 Jev 净 +410；738 手全部 fallback 净 -3,520；2 手混合净 -670；19 手无需动作净 +190。330 次 Jev 成功调用对应 330 个已接受 Jev 决策，另有 746 个已接受 fallback 决策；请求数、决策数和手数不能混用。该样本逐手起始及最终筹码与原始服务器事件全部吻合，50 手正收益也与原始赢底池记录一致。

该快照预算门槛触发前 234 手净 -350，触发后 721 手净 -3,240。旧版运行合同妨碍了纯 Jev 采样，不能据此得出 Jev 持续决策九小时仍一路亏损。也不能用 196 手 +410 宣称策略优势：小样本波动大，且剔除混合失败手存在选择偏差。新版本保留旧样本、停止按金额限制调用，并验证每个提交动作的 Jev 来源。

## 决策重跑

```sh
npm run evaluate -- --demo --run demo-jev --strategy baseline --limit 8
npm run evaluate -- --run RUN_ID --strategy jev --limit 10
REASONING_API_FORMAT=messages npm run evaluate -- --run RUN_ID --strategy jev-reasoning --limit 2
```

每次评估从原记录读取冻结 context 与候选，不修改真实 Run。结果保存独立 ID、原 decision ID、新旧候选、成功/失败、平均延迟和估算成本。界面 Evaluations 仅查看已经生成的报告，不创建新调用。

本轮部署目标为纯 Jev，每个样本直接交给 Jev 从冻结候选中选择，供应商重试独立记录。组合策略仅在显式实验中启用：`REASONING_MODE=always` 先分析再由 Jev 作最终选择；专用 DeepSeekProvider 支持 `deepseek-flash` 与关闭 thinking，其他 provider 同样必须明确配置，不作为自动兜底。只有显式 `REASONING_MODE=adaptive` 使用 Jev 路由、按需分析及再次选择。全链路受总 deadline 限制；无法及时获得有效 Jev 选择时记录失败并停牌，不提交本地 fallback 动作。分析模型不能直接向牌桌提交动作。

重跑结果只统计选项一致数、错误数、延迟与费用；不会把原牌局结算赋给替代策略。不同 Run 的真实收益可以并列查看，但公开 Arena 的时段、对手和牌序不受控，不能据此做因果归因。

## API 协议与模型一致性

- Jev：`POST https://api.typesafe.ai/v1/systemone`，固定请求 `jev-1.13.0`，Choice 必须属于候选，概率项齐全且有效，总和容差 1%，choice 与最高概率一致。
- DeepSeek：专用 `POST /anthropic/v1/messages`，可选实验使用 `deepseek-flash`、`thinking.type=disabled`，不发送 effort。保存分析、实际模型和含缓存分类的 usage；不将关闭思考的分析标作 thinking 返回。
- 标准 Responses：配置 `/v1` base URL 后调用 `/responses`，默认请求 `reasoning.effort=high` 与 `summary=auto`，保存实际返回的分析和推理摘要，拒绝静默模型替换。
- 标准 Messages：调用 `/messages`，使用 `x-api-key`、`anthropic-version`、`thinking.type=adaptive` 与默认 `output_config.effort=high`，保存供应商实际返回的分析、thinking 文本及 usage。没有返回的思考内容不补写。
- 代理返回的模型名只能证明接口所报告的身份，不能独立审计其底层模型。

当前实测曾出现请求 `gpt-6-astra` 而代理返回 `gpt-5.6-luna`。协议 HTTP 成功不等于 GPT-6 验证成功；严格校验将该结果标记为 `model_mismatch`。Claude Messages 探针请求和返回均为 `claude-opus-5`。完整记录见验证文档。

## 费用账本

公开 Jev 价格为输入 $0.042 / 百万 token、输出免费。调用按估算预记费用，响应提供 usage 后结算；估算不是供应商实际扣费。输入字节上限限制上下文大小，费用记录不设置金额门槛，不因累计估算或未知用量阻止调用。

组合策略由 `LedgerMeter` 对每次 analysis 和 Jev 选择独立预留、结算；adaptive 模式的 route/reconsider 同样逐次计费，避免整条流程只计一次费用。未知、取消或未返回 usage 的请求保留预留金额，不假定免费。已返回 usage 的失败/模型不一致响应仍计费。账本保存在 SQLite，重启不会清零。

两类模型请求默认首次尝试后最多重试 3 次，逐次保存请求模型、返回模型、状态、耗时和费用；临时网络、限流、服务端错误、单次超时和无效响应可重试，鉴权、供应商真实余额不足、模型不匹配及账本失败不盲目重复。所有重试共享原行动期限，验证重试次数与费用时不能把一次决策当作一次供应商请求。

会话重跑保留原决策的信息截止：最多 12 个先前回合，每回合分析最多 4000 字符、总计 12,000 字符。输入裁剪优先保留较近回合并记录长度与截断；Jev 建议另受完整请求大小限制。完整原文仍保留在已保存记录中，不能用后来补充的分析覆盖原输入。

Responses/Messages 的费率使用 `REASONING_INPUT_PRICE_PER_MILLION`、`REASONING_OUTPUT_PRICE_PER_MILLION`，默认仅是参考估算，必须按所用供应商账单调整。代理可能加入额外输入或采用不同计价；本地 token 估算不是供应商美元硬上限。Overview/Run 成本包含已知费用和未知请求预留；单决策费用来自其关联调用，尚未关联的取消请求仍留在 Run 账本中。

当前运行不使用 `TOTAL_BUDGET_USD`、`RUN_BUDGET_USD` 或 CLI `--budget-usd`。旧账本和未知用量继续保存，不能把未知预留当成已经扣费，也不清零记录以伪造可用额度。供应商实际拒绝、无效响应或超过期限时保存失败；Live 不生成本地行动。Jev 默认单次 10 秒、总期限 40 秒、首次调用后最多重试三次，实际仍受平台回合期限约束。失败停牌持久化，显式恢复见[运行手册](running.md#模型失败停牌与显式恢复)。

## 自动化验证范围

| 层       | 主要验证行为                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Core     | Reducer、合法候选、raise-to 边界、信息截止、对手统计和去重                                             |
| Policies | Jev 结构/概率校验、超时、异常、thinking 参数、严格模型匹配、always/adaptive 与最终选择                 |
| Runtime  | 自动入队、唯一行动权、无本地 fallback、失败停牌、迟到取消、重复消息、断线/resync、幂等重发、停止和恢复 |
| Storage  | 冻结数据、记录关联、缺失历史、结算/买入隔离、费用估算、取消计费、重启和租约                            |
| Server   | 查询/控制、鉴权、跨站请求保护、只读演示、评估持久化                                                    |
| Browser  | 合成数据的 Overview、SSE/Live、Replay、Decision、只读 Evaluations、深色控件和移动端布局                |

所有版本控制文本文件不超过 1000 行。`npm run check` 执行 lint、格式、类型、测试、构建和行数/本地凭据扫描；浏览器验证单独运行 `npm run test:e2e`，CI 执行两者。

## 真实 Arena 验收方法

早期有界验收采用纯 Jev、单个 Bot 连接、独立本地验证数据库，计划最多 30 分钟并观察至少 10 手完成。第二次实际运行 24 分 49 秒，因开始服务器迁移而在手牌边界停止；不将其记作 30 分钟持续验收通过，实际结果见验证报告。当时核对已接受/拒绝/未决动作、旧版 fallback 原因、缺失历史、费用和正常离桌；该 fallback 行为不属于当前运行合同。真实运行期间不启动第二个同账号 WS 客户端。

断线、超时、ACK 丢失和恢复错误主要通过本地可控协议测试验证；自然运行中没有发生的故障，不宣称已经在生产环境实测。合成演示、接口探针与真实对局分别报告。短期输赢不设为工程验收阈值。

## 官方依据

- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe API](https://docs.typesafe.ai/api) 与 [Models](https://docs.typesafe.ai/models)
- [OpenPoker Message Types](https://docs.openpoker.ai/api-reference/message-types/)
- [OpenPoker State Consistency](https://docs.openpoker.ai/building-bots/state-consistency/)
- [OpenPoker Reconnection](https://docs.openpoker.ai/building-bots/reconnection-idempotency/)
