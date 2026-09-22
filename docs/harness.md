# Pure Jev poker harness

## 本次目标 / Objective

以真实结算净筹码与 bb/100 为主要效果指标，发布可审计的纯 Jev 决策版本。Jev 作最终动作选择；本地代码只计算牌局事实、构造合法候选和提供明确标注的策略依据，不代打，不按金额限制调用。历史原始数据保留。

The objective is better realized chip returns, measured by settled net chips and bb/100. Jev selects the final legal action. Local code supplies auditable poker facts and explicitly qualified strategic evidence, without monetary call limits or substitute actions. Historical records remain intact.

## 冻结复盘样本

服务器一致备份截至 2026-09-21 23:39:45 UTC。Run `2523bf71-54dd-47c2-a46f-1cad2d17f22f` 实际运行 16:03:54–19:19:08 UTC：295 手可靠结算，净 -10,551 筹码，-178.83 bb/100；519 个 Jev 动作被接受，0 本地 fallback。另有3条缺少英雄底牌及起始筹码的牌桌观察记录（2条 complete、1条 playing），不混入英雄净收益。最终因重连恢复回合缺少剩余期限信息而停牌，并非累计金额限制或供应商余额拒绝。逐手损失分析和验证结果将在发布前补充。

This frozen run contains 295 verifiable settlements, -10,551 chips and -178.83 bb/100, with 519 accepted Jev actions and no local fallback. It stopped after reconnecting to a turn whose remaining deadline was treated as unknown. These observations do not establish the cause of every loss or the EV of an alternative action.

## 新输入合同 / Revised input contract

设计先记录在此；以下是本次实现与验收范围，不是已验证的上线声明。

| 数据                                      | 处理方式与理由                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| 当前自己底牌、公共牌、合法行动            | 必须；只使用当前可见信息，不读取未来公共牌或对手未公开底牌                 |
| 底池、跟注额、可用余额、当街投入          | 必须分开；候选显示新增投入、raise-to、跟注赔率与全下的含义                 |
| 庄家、座位、活跃对手、位置、有效筹码、SPR | 提供明确派生值与未知标记，避免让模型从原始JSON猜算                         |
| 牌型、踢脚、牌面结构、听牌                | 确定性本地计算；展示计算依据，不伪造模型思考                               |
| 本手行动和会话                            | 保留街道、金额、来源；压缩重复标识和重复会话文本，完整原文仍留库           |
| 对手倾向                                  | 展示样本数量与分母定义；未知金额或少量样本不能生成强结论                   |
| 随机范围摊牌胜率（如实现）                | 明确假设、样本量；不是下注范围胜率、行动EV或盈利保证                       |
| 最近若干手输赢、UUID、重复时间戳          | 完整留库与复盘；从即时 Jev 策略输入移除与当前选择无关的短期结果噪音        |
| 策略原则                                  | 版本化，关注范围、位置、价值下注、赔率和风险；不按单手历史收益硬贴好坏标签 |

Preflop candidates include conventional opening/isolation sizes and raises based on the visible wager. Postflop candidates include small, medium and pot-sized wagers. Every amount must satisfy the platform's bounds. Legal fold/check/call/all-in choices remain available; no local policy silently replaces Jev's selection.

## 恢复、评估与发布

对重连问题只复用已观测到的同一回合真实期限，不从重连时间重新获得完整行动时间；无法证明有效期限时保持失败记录。模型单次10秒，首次之后最多3次重试，共享平台期限；Jev失败仍不能由本地动作兜底。

先用数学单元测试核对牌型、赔率、筹码语义和无未来信息；再冻结历史输入，对照新旧真实 Jev 输出。选项改变、消除明确策略错误、耗时与失败率可实测，历史收益不能赋给替代动作。盈利效果需要新版真实Run，单独报告样本量、累计净收益、bb/100、盈利手占比、最大回撤和不确定性。

发布采用现有 GitHub 无缓存多架构镜像流水线，在官方确认离桌后手动 Docker Compose 更新，保留全部历史。恢复已停牌服务之前必须解决并验证实际停牌原因。公开网页只读，必须可以复查当前版本实际提供给 Jev 的依据。

## Pi 的参考方式 / What we take from Pi

参考 [Pi agent core](https://github.com/badlogic/pi-mono/tree/main/packages/agent) 的 `transformContext → convertToLlm` 与请求准备钩子，以及 [Pi coding agent sessions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 的“完整事件留存，模型上下文另行投影”。这是一种工程设计参考，Pi 本身没有扑克策略或盈利能力；本项目不引入无关 coding-agent 运行时。

对应到牌桌循环：服务器事件 → 冻结局面 → 确定性牌局工具 → 检索同桌对手的已完成交手证据 → 精简模型输入 → Jev 选择 → 合法性/期限校验 → 行动确认 → 结算及长期记忆。每手是短会话，跨手对手记忆独立持久化；新输入保留每条证据的信息截止。摘要可以更新，原记录不能被摘要覆盖。

长期对手记忆优先使用公开行动与公开摊牌：按街统计下注/跟注/弃牌机会，展示已公开底牌的实际下注线路与来源手牌。只有已完成、在当前决策之前收到的数据才能进入记忆；不能从未来结果倒推当前隐牌。识别宽范围、过度跟注或弃牌等倾向后，提供有条件的调整原则，由 Jev 综合当前价格与牌力决定。稀少或有选择偏差的摊牌不等于完整范围，更不是对手固定策略。

## 实现后的输入取舍

Jev 接收准确的当前牌型与牌面相对强度、位置、分开的筹码/投入、合法候选成本、当手行动、当前活跃对手的长期证据，以及同手已接受动作。随机范围摊牌估算保留在冻结记录和复盘界面中，**不进入默认 Jev 请求**：它没有按实际下注筛选对手范围，可能给弱 bluff-catcher 提供错误的数字锚点。近期输赢和重复标识也只留作审计。

对手证据最多取每个名字最近200手已观察结算，公开摊牌最多3例，实际模型投影再加入最近1例交手并去重。每条线明确缺失价格与截断数量。过长请求优先删减历史实例，并记录 `examplesOmittedForInputSize`；当前牌局事实不因此从数据库丢失。仅按公开名字关联，名字变化或冒用不能识别为同一真实账户。

`context.harness` 是完整冻结工具依据；`proposal.request.state` 才是最终 Jev 输入，二者不等同。各手牌策略版本为 `visible-context-v6` / `street-sized-raise-to-v2` / `opponent-encounters-v3` / `poker-harness-choice-v5`。应用版本为 `1.1.0`。实际验收与部署结果见 [verification.md](verification.md)。

独立合成策略诊断可显式调用真实 Jev，不连接 Arena：

```sh
npm run build
node --env-file=.env scripts/probe-harness.mjs
```

输出报告和费用账本保存在被忽略的 `data/harness-probes/`。默认CI不执行此付费诊断。16个独立场景的期望行动仅用于评分，不放进模型请求；它们检查关键行为，不证明实际EV或盈利能力。
