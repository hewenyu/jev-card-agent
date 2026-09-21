# 接入方式调研与决定

## 已确定的接入

采用 Node.js + TypeScript 自托管 Bot，通过 `wss://openpoker.ai/ws` 连接 OpenPoker。Runtime 直接调用 Jev 的 HTTPS 请求—响应 API。HTTP webhook、异步结果回调和远程决策 worker 不在交付范围内。

| 服务           | 地址                                            | 用途                                    |
| -------------- | ----------------------------------------------- | --------------------------------------- |
| OpenPoker WS   | `wss://openpoker.ai/ws`                         | 实时状态与行动                          |
| OpenPoker REST | `https://api.openpoker.ai`，路径以 `/api/` 开头 | 身份、活跃牌局、历史与统计              |
| Jev            | `https://api.typesafe.ai/v1/systemone`          | POST state/model/questions，返回 Choice |

Bot 主动外连，无需为了接收牌局事件开放公网 webhook。产品控制台的认证和访问端口按部署文档配置。

## 调研依据

当前公开资料没有列出 OpenPoker 原生 HTTP 行动 webhook、callback URL 注册或异步 job/result 合同。REST 管理 hosted bot 策略和启停，不等于自托管策略可以逐回合通过 HTTP 行动。赛事通知文档描述 email。

OpenPoker 检查覆盖 [sitemap](https://docs.openpoker.ai/sitemap-0.xml) 的 36 个页面、llms.txt、llms-full.txt 和官方链接的 [openpoker-skill](https://github.com/joaoCarvalho1000/openpoker-skill)。搜索 webhook、callback、202 Accepted、job_id、result_url 未发现实时回调合同。官方链接的 [平台源码仓库](https://github.com/joaoCarvalho1000/open-poker) 公开访问返回 404，无法据此判断未公开能力。因此结论限定为“公开文档未列出、未核实支持”。

TypeSafe [API](https://docs.typesafe.ai/api)、[文档索引](https://docs.typesafe.ai/llms.txt) 和 [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient) 定义的是本次请求直接返回结果。SDK Promise/async 是非阻塞 I/O，不是 webhook 或后台任务合同。

## 时间预算

OpenPoker 公开场当前行动窗口为 45 秒，重连不延长。TypeSafe SDK 的单次 timeout 默认 10 秒、默认重试 2 次，Retry-After 等待可到 60 秒；不能直接当作实时决策总预算。

Runtime 使用覆盖完整请求、响应读取和重试的 AbortSignal，保留 fallback 与提交余量。迟到结果不能用于新回合。

依据：[RequestOptions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)、[RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)、[OpenPoker Reconnection](https://docs.openpoker.ai/building-bots/reconnection-idempotency/)。

## 已记录的探针结果

Node.js 24.13.0 临时诊断：REST profile 返回 200；active-game 返回 200 且 playing=false；WS upgrade 返回 101、accept 校验通过，并收到 connected。探针未发送 join_lobby 或游戏行动，连接后关闭。

这些仅证明连接鉴权可用。实际 Runtime、自动牌局及恢复验证的结果在实施后单独记录于评估文档，不把此探针当作完整验收。

## 免费筹码、买入与持续参赛

OpenPoker 的核心对局使用免费的整数虚拟筹码。账户 `/api/me` 中的 `balance` 属于支付余额，不能用于牌桌买入判断；运行时只读取 `/api/season/me` 的 `chip_balance` 和 `chips_at_table`，以及 `/api/me/active-game` 的在桌状态。

当前官方公共赛季合同：

- `join_lobby.buy_in` 必须为 1,000–5,000；余额足够时使用配置额度，余额不足配置额度但仍有至少 1,000 时按实际余额降低买入。例如默认请求 2,000，补筹后只有 1,500，应以 1,500 入场。
- 每次 rebuy 增加 **1,500** 虚拟筹码，当前赛季 score penalty 为 **0**。首次立即可用，Free 后续冷却 **5 分钟**，Pro **2 分钟**。
- rebuy 条件是已离桌、`chips_at_table == 0` 且 `chip_balance < 1000`。WS 请求必须包含 `amount`，但服务器忽略该值；不能通过设置金额索取更多筹码。
- 已启用 `auto_rebuy` 时，由服务器自动安排补筹。`auto_rebuy_scheduled` 提供 `rebuy_at` / `cooldown_seconds`；`rebuy_confirmed` 增加离桌余额，并不表示已经入座，之后仍需重新 `join_lobby`。
- REST `POST /api/season/rebuy` 在冷却中返回 429 和 `Retry-After`；未验证邮箱返回 403 `email_not_verified`，仍有桌上筹码或离桌余额不少于 1,000 时返回 400。Runtime 不根据支付余额调用购买 Pro 或其他付费接口。

持续参赛保留自动补筹与低频恢复检查：收到补筹确认后核对赛季余额再入队；冷却中不反复发送 rebuy 或 join。重连和进程恢复重新读取赛季状态，不能因为 WebSocket 恢复就重新索取筹码。正常 drain 优先于补筹和重新入队：停止请求等待当前手牌边界，然后离桌，不启动新的匹配。

官方依据：[REST API](https://docs.openpoker.ai/api-reference/rest-api/)、[消息合同](https://docs.openpoker.ai/api-reference/message-types/)、[赛季与补筹](https://docs.openpoker.ai/compete/rebuys/)、[完整官方文档](https://docs.openpoker.ai/llms-full.txt)。`rebuy_confirmed` 文档中的 2,000 余额示例不等于补筹金额；明确规定的补筹金额为 1,500。

## 状态哈希与 JSON 数字保真

一次生产恢复失败发生在 `between_hands_delay` 状态。按官方合同移除顶层 `ts`、`table_seq`、`hand_seq`、`state_hash`，用 Python 的 `json.dumps(sort_keys=True, ensure_ascii=True, separators=(',', ':'))` 重算已存事件，两条等待快照均不匹配。仅将 `waiting_details.configured_delay_seconds` 从整数 `5` 恢复为浮点数 `5.0`，两条 SHA-256 均与服务端完全一致；其他正常快照无需修正即可匹配。

原因是 JavaScript 将 JSON 数字 `5` 与 `5.0` 都解析为同一个 `number`，普通 `JSON.stringify` 又都输出 `5`；Python canonical JSON 保留 `5.0`。这会改变哈希输入，并使普通事件持久化丢失复核证据。修复在接收原始 JSON 时使用 Node.js 24 的 reviver `context.source` 保存数字词法，独立于业务数值对象保存元数据；哈希排序和原始事件序列化保留该词法，包含嵌套恢复快照、重放事件及数组。业务状态、合法动作和模型输入仍使用正常数值类型。

恢复校验继续遵循官方字段排除和 SHA-256 合同；不根据字段名称猜测浮点数，不忽略哈希，也不修改筹码状态。只有新接收并保留数字词法的事件能够完整复核；已经通过普通 `JSON.stringify` 丢失词法的旧记录不回填猜测值。现场数字恢复仅用于诊断，不作为运行时兼容分支。

官方依据：[V2 消息合同的 state_hash verification](https://docs.openpoker.ai/api-reference/message-types/)及[完整文档](https://docs.openpoker.ai/llms-full.txt)。哈希证明快照一致性，不证明完整收到所有私有事件。
