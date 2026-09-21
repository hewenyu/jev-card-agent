# 接入方式调研与决定

## 已确定的接入

采用 Node.js + TypeScript 自托管 Bot，通过 `wss://openpoker.ai/ws` 连接 OpenPoker。正式组合策略由后端先调用推理服务的 HTTPS API，再调用 Jev 的请求—响应 API 作最终选择。HTTP webhook、异步结果回调和远程决策 worker 不在交付范围内。

| 服务              | 地址                                             | 用途                                    |
| ----------------- | ------------------------------------------------ | --------------------------------------- |
| OpenPoker WS      | `wss://openpoker.ai/ws`                          | 实时状态与行动                          |
| OpenPoker REST    | `https://api.openpoker.ai`，路径以 `/api/` 开头  | 身份、活跃牌局、历史与统计              |
| Jev               | `https://api.typesafe.ai/v1/systemone`           | POST state/model/questions，返回 Choice |
| DeepSeek Messages | `https://api.deepseek.com/anthropic/v1/messages` | 专用 provider 的推理分析                |

Bot 主动外连，无需为了接收牌局事件开放公网 webhook。产品控制台的认证和访问端口按部署文档配置。

## 网站实时观战：单向 SSE

网站是公开只读展示端，浏览器通过同源 `GET /api/live` 接收 `text/event-stream`，不持有 OpenPoker、Jev 或内部管理凭据，也不直接连接 Arena。部署使用 `PUBLIC_HISTORY=true` 开放匿名观战及已结束历史；内部管理 API 仍由 `API_TOKEN` 保护，公开反向代理拒绝写请求。此链路是从本项目后端向浏览器推送展示数据，不是 OpenPoker 的 webhook。

每次连接立即发送 `event: snapshot`，其 JSON 数据为 `SpectatorSnapshot { sequence, observedAt, runtime, recentEvents }`。此后 Runtime 状态变化继续推送完整快照，15 秒发送一次 SSE 注释心跳。浏览器使用 EventSource 自动重连，重新取得当前快照；不依赖 Last-Event-ID 补齐历史。首次连接和每次重连只恢复当前桌面，之后按 movement ID 播放新事件，避免把初始快照中的历史动作重复动画。

实时表格包含公共牌、Bot 自己的当前手牌、底池、座位名称、筹码、当前投注、弃牌状态、行动座位及牌局标识。Bot 所有者明确要求公开自己的手牌；不包含未公开的对手底牌。SSE 同时提供当前决策阶段，`GET /api/live/decisions` 提供当前手已保存的决策及分析。合法动作授权、turn token、鉴权密钥和运行错误不进入公共投影。已结束手牌的脱敏历史由历史 API 提供。

模型调用由后端配置控制：本轮目标 `REASONING_MODE=always` 每次先请求 DeepSeek Flash 关闭 thinking 的分析，再让 Jev 选择；`always` 不等于开启思考。一个 session 对应一手牌，输入由持久化的、截止当前回合可见的同手历史重建；不依赖供应商会话存储。仅 `REASONING_MODE=adaptive` 使用旧的 Jev 按需分析门控。浏览器只读取调用进度与已经保存的结果，不能改策略或触发额外调用。

`recentEvents` 最多保留当前 Run、当前桌、当前手牌的 32 个公开事件，包括开始、玩家动作和结算。`ChipMovement` 使用稳定 ID、座位、整数筹码金额及 `to-pot` / `from-pot` 方向。下注金额仅取协议的 `contribution_delta` 或已知的 `stack_before - stack_after`；raise-to 总额不能当作本次投入筹码。结算只使用 `hand_result.payouts` 的 `{seat, amount}` 数组。无法核实的筹码变化不生成动画；桌面状态仍按已验证 Runtime 快照更新。

Runtime 在事件刚到达时尚未更新 reducer，观战模块延后到微任务读取更新后的状态，并忽略旧序列及其他手牌事件。事件 ID 和序列水位防止重复消息或重连后重复动画。浏览器断开后释放订阅和心跳；慢消费者一旦触发 HTTP 写入背压即断开，重连获取最新完整快照，不在服务端累积无界消息队列。

匿名 `GET /api/evaluations` 仅展示所有引用决策都属于已结束手牌的已有评估；含进行中或缺失决策的整份结果不公开。公开网站不能创建新评估、启动或停止 Bot，也不能触发模型费用。

## 调研依据

当前公开资料没有列出 OpenPoker 原生 HTTP 行动 webhook、callback URL 注册或异步 job/result 合同。REST 管理 hosted bot 策略和启停，不等于自托管策略可以逐回合通过 HTTP 行动。赛事通知文档描述 email。

OpenPoker 检查覆盖 [sitemap](https://docs.openpoker.ai/sitemap-0.xml) 的 36 个页面、llms.txt、llms-full.txt 和官方链接的 [openpoker-skill](https://github.com/joaoCarvalho1000/openpoker-skill)。搜索 webhook、callback、202 Accepted、job_id、result_url 未发现实时回调合同。官方链接的 [平台源码仓库](https://github.com/joaoCarvalho1000/open-poker) 公开访问返回 404，无法据此判断未公开能力。因此结论限定为“公开文档未列出、未核实支持”。

TypeSafe [API](https://docs.typesafe.ai/api)、[文档索引](https://docs.typesafe.ai/llms.txt) 和 [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient) 定义的是本次请求直接返回结果。SDK Promise/async 是非阻塞 I/O，不是 webhook 或后台任务合同。

## 时间预算

OpenPoker 公开场当前行动窗口为 45 秒，重连不延长。TypeSafe SDK 的单次 timeout 默认 10 秒、默认重试 2 次，Retry-After 等待可到 60 秒；不能直接当作实时决策总预算。

Runtime 使用覆盖完整请求、响应读取和重试的 AbortSignal，保留提交余量；Jev 最终失败不提交本地行动并持久停牌。迟到结果不能用于新回合。

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

## DeepSeek Messages 专用合同

DeepSeek 通过 `REASONING_PROVIDER=deepseek` 明确选择专用 provider，默认 `standard` 的 Responses / Messages provider 保持原有职责。使用独立 `DEEPSEEK_API_KEY`，不回退到标准 provider 密钥。`DEEPSEEK_API_BASE_URL` 默认官方 Anthropic base URL `https://api.deepseek.com/anthropic`，最终请求路径为 `/anthropic/v1/messages`；使用 `x-api-key` 鉴权，不将凭据放在 URL。`anthropic-version` 在该兼容入口被忽略，`max_tokens`、`messages` 和 `stream` 属于支持字段。

| 项目       | 专用 provider 合同                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 型号       | 官方请求 ID `deepseek-flash` 对应 DeepSeek-V4.1-Flash；不猜测 `deepseek-v4.1-flash` 等名称       |
| 思考开关   | 显式 `thinking: { type: 'enabled' }` 或 `{ type: 'disabled' }`，不用标准 Messages 的 `adaptive`  |
| 强度       | 启用时发送 `output_config.effort`；`REASONING_EFFORT=medium` 映射 `high`，`max` 仅 DeepSeek 可用 |
| 思考预算   | 官方忽略 `thinking.budget_tokens`，不能用它证明限制已生效                                        |
| 返回校验   | 核对响应 `model` 与请求 ID，并要求完成响应及可用分析；保存实际返回的 thinking，缺失时标明未提供  |
| 故障与计费 | 与现有 provider 共用取消、逐次预留/结算、重试和总 deadline；未知用量保留预留                     |

官方明确说明未知模型名会自动映射到 `deepseek-flash`；`claude-opus*` 会映射到 `deepseek-v4-pro`，`claude-haiku*` / `claude-sonnet*` 映射到 Flash。旧 Flash 名称也可能被映射到已更新模型。因此 HTTP 200 不能单独证明请求型号成立；专用 provider 限制已知型号并严格比较实际返回值，不能利用映射掩盖模型身份不匹配。

缓存输入保留供应商原 usage，并按 Messages 口径将 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 归一化为总输入，分别保存缓存字段；不得直接套用其他协议的总输入字段。缓存读取按独立费率，非缓存输入与缓存写入按普通输入费率计价。DeepSeek 专属 `DEEPSEEK_INPUT_PRICE_PER_MILLION`、`DEEPSEEK_CACHE_READ_INPUT_PRICE_PER_MILLION`、`DEEPSEEK_OUTPUT_PRICE_PER_MILLION` 默认分别为 $0.30、$0.006、$1.20，使用本次官方 Flash 文档的保守峰值。官方谷值为其一半；预留不能假设必定命中缓存或处于谷时，估算价不代替最终供应商账单。

所有者已选择本轮目标 `DEEPSEEK_MODEL=deepseek-flash`、`DEEPSEEK_THINKING=disabled`，请求不发送 `output_config.effort`。分析单次 10 秒，首次之后最多 3 次重试并共享 40 秒 Hybrid deadline；最终行动仍由 Jev 决定，不自动调用 GPT 或 Claude 兜底。实际集成与上线状态另记验证报告。

合同依据：[Anthropic API 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)。支持字段与官方价格是文档证据；真实返回、延迟及思考开关对比另记[验证报告](verification.md)。
