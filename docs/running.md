# 运行与部署手册

本手册对应实际 Node.js 命令、环境变量和控制接口。当前实现使用纯 `jev`：通过 [harness](harness.md) 计算牌局事实、构造按街候选、检索已完成对手交手，再由 Jev 选择合法行动，不额外调用分析模型。完整历史保留，模型请求使用单独的精简投影。实际部署、复盘和验收状态见[验证报告](verification.md)。实时游戏连接使用 OpenPoker WebSocket V2，Demo、历史回放和真实 Arena 数据分别标识。

## 安装

需要 **Node.js 24.x** 和 npm。无需 PostgreSQL 或 Redis；SQLite 通过 Node.js 内置 `node:sqlite` 使用。Node.js 24 可能显示 SQLite 实验性 API 提示，这不表示数据库未启用。

```sh
node --version
npm ci
```

`package-lock.json` 是 npm 标准 lockfile 的紧凑 JSON 表达，`npm ci` 可直接读取。更改依赖后运行 `npm run format` 恢复紧凑格式。

## 无凭据演示

```sh
npm run demo
```

打开 **http://127.0.0.1:8787**。命令执行生产构建，再以 `--demo` 启动完整应用，默认使用 `data/demo.sqlite`。它不加载 `.env`，而且 Demo 模式会清空运行配置中的平台和模型凭据，禁止启动真实 Runtime。

本地 Demo 提供四个只读视图、逐事件回放和已保存实验结果展示；baseline 比较通过下文 CLI 生成。牌局、模型概率和收益均是明确标记的合成数据。

更换端口或演示数据库：

```sh
PORT=8790 DEMO_DATABASE_PATH=data/presentation.sqlite npm run demo
```

Demo 优先使用 `DEMO_DATABASE_PATH`，其次是进程环境中的 `DATABASE_PATH`，最后才是默认路径。为 Demo 使用独立数据库；应用会拒绝在包含真实 Run 的数据库中启动 Demo。

## 开发与生产控制台

```sh
cp -n .env.example .env
chmod 600 .env
npm run dev
```

修改已有配置时保留 `.env`，不要再次覆盖。开发模式同时运行 API 和 Vite：界面默认 `http://127.0.0.1:5173`，以终端输出为准；API 默认 `http://127.0.0.1:8787`。Vite 将 `/api` 代理到本地 API。

生产启动：

```sh
npm run build
npm run start
```

`start` 使用构建产物并读取 `.env`，单个 Node.js 服务提供 React 静态页面、HTTP API 和 Bot Runtime。网页只读；服务器通过 `AUTO_START_BOT=true` 启用启动后自主参赛，通过 `PUBLIC_HISTORY=true` 开放匿名实时观战与历史。未启用自动启动时不入队。

```sh
curl --fail http://127.0.0.1:8787/health
```

健康响应只证明 HTTP 服务可响应。实际连接、恢复、运行错误和牌局状态从控制台检查。

## 配置参考

真实秘密只放入 `.env`、进程环境或部署平台秘密配置。完整占位样例见[`.env.example`](../.env.example)。

公开手册和脱敏验证结论保留在 `docs/`。服务器地址、SSH 凭据、私人部署参数、原始模型/牌局记录另存于被忽略的 `data/deployment/` 或仓库外，不复制到公共文档或镜像上下文。

| 变量                       | 默认/含义                                                     |
| -------------------------- | ------------------------------------------------------------- |
| `OPEN_POKER_API_KEY`       | OpenPoker Self Host Bot 凭据；正式参赛必需                    |
| `OPEN_POKER_WS_URL`        | `wss://openpoker.ai/ws`                                       |
| `OPEN_POKER_REST_BASE_URL` | `https://api.openpoker.ai`                                    |
| `JEV_API_KEY`              | TypeSafe Jev 凭据；Jev/组合策略必需                           |
| `JEV_BASE_URL`             | `https://api.typesafe.ai`                                     |
| `JEV_MODEL`                | `jev-1.13.0`                                                  |
| `JEV_TIMEOUT_MS`           | `10000`，单次 Jev 请求期限                                    |
| `JEV_DECISION_TIMEOUT_MS`  | `40000`，纯 Jev 整次决策期限，仍受平台行动期限约束            |
| `HOST`、`PORT`             | `127.0.0.1`、`8787`                                           |
| `DATABASE_PATH`            | `data/jev.sqlite`；生产持久化路径                             |
| `DEMO_DATABASE_PATH`       | `data/demo.sqlite`；演示路径                                  |
| `API_TOKEN`                | 内部管理 API 凭证；非只读 Demo 的公开监听必需，至少 24 个字符 |
| `READ_ONLY_DEMO`           | `false`；设为 `true` 后使用合成数据，禁止写请求和真实运行     |
| `PUBLIC_HISTORY`           | `false`；开放匿名观战、Bot 自己手牌、本手已保存分析与结束历史 |
| `AUTO_START_BOT`           | `false`；设为 `true` 后，HTTP 监听成功时自动启动一次 Bot      |
| `BOT_STRATEGY`             | 默认 `jev`；本轮正式运行显式设置 `jev`                        |

`OPENPOKER_API_KEY`、`OPENPOKER_WS_URL`、`OPENPOKER_REST_URL` 作为兼容别名保留；同时配置时优先 `OPEN_POKER_*`。

费用是用量与配置单价的估算，不是账户余额或供应商账单。取消/失败而用量未知的调用保留费用预留，不假定失败免费。费用账本随数据库保存；未知用量预留仅用于估算费用，不阻止后续调用。程序不再使用 `TOTAL_BUDGET_USD`、`RUN_BUDGET_USD` 或 `--budget-usd`；从私有配置移除旧项，供应商真实余额不足仍会作为模型失败停牌。

## 连接与模型探针

```sh
npm run diagnose
```

需要 OpenPoker 凭据，检查 REST 当前状态和 WS 鉴权握手，不发送 `join_lobby`。如果已在牌桌上或本地 Runtime lease 正被占用，诊断会跳过 WS，避免接管运行中的连接。

显式增加付费 Jev 探针：

```sh
npm run diagnose -- --jev
```

只检查推理供应商，不连接 OpenPoker：

```sh
npm run diagnose -- --reasoning --skip-openpoker
```

模型探针产生费用并记录用量；它只验证接口合同、返回模型与单次响应，不能证明扑克能力或平均性能。报告不打印完整分析文本或秘密。

## 正式自动参赛

填写 `OPEN_POKER_API_KEY`、`JEV_API_KEY` 与内部 `API_TOKEN`，设置 `AUTO_START_BOT=true`、`BOT_STRATEGY=jev`、`PUBLIC_HISTORY=true`，执行 `npm run build`、`npm run start`。纯 Jev 不需要 `DEEPSEEK_API_KEY` 或其他分析模型密钥；单次请求默认 10 秒，整次决策默认 40 秒，最多重试三次。费用只记录，不作金额限制。完整地址与部署配置见[部署手册](deployment.md)。服务启动后自动参赛，网页只展示实时牌桌、自己的手牌和已保存决策。策略、模型、期限和自动启动配置保存在后台。

无界面入口：

```sh
npm run bot -- --strategy jev --max-hands 10 --max-minutes 30 --buy-in 2000
```

该命令会正式入队、匹配、自动决策和结算。不要同时用同一 Bot 启动其他 Runtime。单数据库 lease 防止重复本地控制，不能协调另一数据库或另一台机器上的 Bot。

| 参数               | 含义                                                             |
| ------------------ | ---------------------------------------------------------------- |
| `--strategy jev`   | 本轮纯 Jev 策略；组合模型实验需显式配置，baseline 仅用于离线对照 |
| `--max-hands 10`   | 达到手数后停止；默认 `0` 不按手数限制                            |
| `--max-minutes 30` | 时长上限；默认 `0` 不按时长限制                                  |
| `--buy-in 2000`    | 虚拟筹码买入；当前平台范围 1,000–5,000                           |
| `--no-auto-rebuy`  | 关闭默认启用的自动补充虚拟筹码                                   |

手数、时长分别是停止条件，不保证指定时间内匹配并完成足够手数。两者均 `0` 时持续参赛，仍受平台行动期限、模型失败停牌和明确停止影响。

首次 `SIGINT`/`SIGTERM` 请求在手牌边界优雅停止，默认不设等待上限；第二次信号请求强制离桌。Compose 部署使用 `sh scripts/manage.sh stop` 等待手牌完成并确认离桌后停止服务。更新代码或迁移数据前先停止 Bot，并确认 Runtime 已停止且平台已离桌，再关闭服务；单手可能超过容器的停止宽限期，不应以强杀容器代替正常排空。

默认重启控制台服务不会自动开始新 Run。重新执行 Bot 命令或启用自动启动时会检查实际牌桌并恢复状态，不把旧回合建议直接提交到新回合。baseline 对照使用下文离线评估入口，不作为正式采样的行动来源。

服务器需要在容器重启后恢复自主参赛时，设置 `AUTO_START_BOT=true`、`BOT_STRATEGY=jev`，保留同一持久数据库。HTTP 监听成功后会调用一次正常的 Bot 启动流程：买入 `2000`、启用 auto-rebuy、不限制手数和时长，模型费用持续记录但不限制调用金额；持久模型失败停牌存在时不会自动入队。启动失败会输出错误、关闭 HTTP 服务并以失败状态退出，由容器重启策略处理。Demo 和只读 Demo 即使设置此开关也不会自动参赛。CLI 的手数、时长限制仍按指定启动参数生效。

此开关只控制进程启动后的参赛，不下载或更新镜像。服务器镜像更新由部署者手动执行 `sh scripts/manage.sh update`，脚本先等待当前手牌结束并确认离桌，再通过 Compose 拉取和重建；不要安装自动更新镜像的服务。

需要由进程管理器自动重启的本地无界面服务，可在构建后使用 `node --env-file-if-exists=.env dist/cli/bot.js --strategy jev` 作为启动命令。该命令启动即参赛，默认不限手数/时长。Docker 部署使用下文的 Compose 管理入口和 `AUTO_START_BOT`，保留控制台及管理 API。模型费用账本与失败停牌状态随持久数据库保留；同一账号只运行一个实例。

## 模型失败停牌与显式恢复

每个正式提交的行动必须有 Jev 的有效合法选择；失败、取消或过期结果不触发本地 check/fold。回合已变化的旧请求取消后直接丢弃；当前合法行动无法获得有效模型结果时，Runtime 保存失败决策和调用诊断后停止参赛，并持久记录停牌状态。平台可能自行执行超时动作，复盘需按平台事件保留，不能归入 Jev 已接受决策。暂停后不继续用本地规则消耗盲注，也不自动重启采样。

服务、容器重启和镜像更新不会清除模型失败停牌。排除实际供应商故障后，由服务器操作者执行 `sh scripts/manage.sh resume`。该命令从容器内访问带内部 Bearer 鉴权的 `POST /api/runtime/resume`，默认按当前配置启动新 Run；公开网页不能触发。HTTP 健康与只读历史在停牌期间仍可用。不要删除数据库、恢复检查点或费用记录来绕过停牌。

## 账户筹码、牌桌筹码与自动补筹

网站分别展示官方账户余额、当前座位筹码和历史净收益；它们来自不同的数据源，不能互相推算：

| 展示值            | 数据来源与含义                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Account available | OpenPoker `GET /api/season/me` 的 `chip_balance`，离桌可用虚拟筹码，用于下一次买入                 |
| Account at table  | 同接口的 `chips_at_table`，官方赛季账户的在桌筹码快照；公开合同未保证与每次 WebSocket 更新同时生效 |
| Seat stack        | 当前 WebSocket 牌桌中 Bot 座位的 `stack`，与当前街已下注的 `bet` 分开展示                          |
| Net result        | 本地已核实手牌的起始/最终筹码差额，不含补筹，不代表账户余额或官方赛季 score                        |

官方赛季 score 按 `chip_balance + chips_at_table` 计算；本地不拿它替代历史净收益，也不把 REST 在桌字段直接当成当前可下注筹码。官方文档没有承诺 `chips_at_table` 恒等于本次买入金额或 `stack + bet`，因此界面保留两种来源及其更新时间。支付账户的美元/USDC `balance` 与这里的虚拟筹码无关。

账户快照在 Runtime 启动时读取，运行期间由后端每 15 秒统一刷新，并在补筹、冷却、入桌、离桌、手牌结算等关键事件后重新核对，经只读 API 和 SSE 更新页面。Runtime 停止后暂停轮询，保留最后快照并标记过期；再次启动先恢复持久记录，再读取官方状态。浏览器不直接访问 OpenPoker、不因刷新页面触发 rebuy。请求失败时同样保留最后成功值并标记过期；未知余额显示未知，不当作 0。判断是否同步应同时查看账户快照更新时间、连接状态和牌桌事件，不能只比较两个不同时间的数值。

公开赛季每次 rebuy 固定增加 **1,500** 虚拟筹码。要求已离桌、`chips_at_table == 0`、`chip_balance < 1000`，且邮箱已验证；首次立即可用，此后 Free 冷却 5 分钟、Pro 冷却 2 分钟。实际等待遵守 `auto_rebuy_scheduled` 的 `rebuy_at` / `cooldown_seconds` 或 REST `Retry-After`。规则冷却长度不是当前剩余时间；没有权威截止信息时不生成假倒计时。

`rebuy_confirmed` 表示离桌余额已补充，**不表示已经入座**。Runtime 重新读取官方余额后再入队，不在前端简单加 1,500，也不改写历史净收益。默认目标买入为 2,000；补筹后仅有 1,500 时按实际可用筹码买入 1,500，不能反复请求不足的 2,000。

补筹确认与冷却安排作为资金事件保存到 SQLite，页面可查看已记录历史，服务重启后恢复最后已知状态。记录包含服务观察时间、来源和已取得的官方余额；账户快照另外显示最近核对时间。缺失的补筹前余额保留为空，不用“当前余额减 1,500”反推。规则额度、确认消息观察和后续 REST 对账按来源区分，避免快速重新买入掩盖补筹。已有记录不代表平台完整账户流水；无法核实的时间或金额仍显示未知。

确认时间是本服务观察到 WebSocket 或 REST 确认的时间，不冒充平台交易时间。旧事件按原始记录 ID 回填；平台未提供唯一事件身份时不按相同余额合并，也不将观察记录条数当作精确补筹次数。

依据：[官方 REST API](https://docs.openpoker.ai/api-reference/rest-api/)、[消息合同](https://docs.openpoker.ai/api-reference/message-types/)、[赛季与补筹](https://docs.openpoker.ai/compete/rebuys/)。补筹事件文档中的 2,000 余额示例不是补筹额度。

## 可选 Jev 与推理模型组合实验

此节仅用于显式选择 `jev-reasoning` 的对照实验，本轮纯 Jev 不执行该流程。DeepSeek 实验可选择 `REASONING_PROVIDER=deepseek`、`DEEPSEEK_MODEL=deepseek-flash`、`DEEPSEEK_THINKING=disabled` 和 `REASONING_MODE=always`：每次有效行动先请求关闭思考的分析，再由 Jev 从合法候选中选择；`always` 不等于启用 thinking。切换策略产生不同 Run。

可选组合流程：**冻结本手 session 与当前局面 → 推理分析 → Jev 最终选择 → Runtime 校验并提交**。推理模型只提供建议和可观察依据，没有动作提交权。只有后台显式设置 `REASONING_MODE=adaptive` 时，才使用旧的 **Jev 初始选择及路由 → 按需分析 → Jev 再次选择** 流程。

always 模式分析超时或供应商失败时，在剩余时间内由 Jev 决策；无法及时获得有效 Jev 结果时不提交本地动作，记录失败并持久停牌，不转向 GPT、Claude 或其他 provider。adaptive 模式分析失败时可保留仍有效的初始 Jev 选择。两种模式的迟到结果均由 Runtime 拒绝，记录失败阶段，不将故障降级标记为完成分析。

| 变量                                 | 含义                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `REASONING_PROVIDER`                 | 默认 `standard`；DeepSeek 实验显式选择 `deepseek`                           |
| `DEEPSEEK_API_KEY`                   | DeepSeek 独立凭据，不复用标准 provider 密钥                                 |
| `DEEPSEEK_API_BASE_URL`              | DeepSeek 官方 `https://api.deepseek.com/anthropic`                          |
| `DEEPSEEK_MODEL`                     | DeepSeek Flash 实验用 `deepseek-flash`；严格核对请求 ID                     |
| `DEEPSEEK_THINKING`                  | 默认 `enabled`；关闭思考实验显式设置 `disabled`                             |
| `REASONING_API_KEY`                  | 标准 Responses / Messages provider 的凭据                                   |
| `REASONING_API_BASE_URL`             | 标准 provider 根地址或 `/v1` 地址；HTTPS，本地测试除外                      |
| `REASONING_API_FORMAT`               | 标准 provider 使用 `responses` 或 `messages`                                |
| `REASONING_MODEL`                    | 标准 Responses 请求模型名                                                   |
| `REASONING_MESSAGES_MODEL`           | 标准 Messages 请求模型名                                                    |
| `REASONING_MODE`                     | 默认 `always`；`adaptive` 为显式按需分析模式                                |
| `REASONING_EFFORT`                   | 默认 `high`；DeepSeek disabled 时不发送 effort，不会因残留配置开启 thinking |
| `REASONING_MAX_OUTPUT_TOKENS`        | 默认 `4096`，分析输出上限                                                   |
| `REASONING_TIMEOUT_MS`               | 默认 `12000`；单次分析期限，仅作用于组合策略                                |
| `HYBRID_TIMEOUT_MS`                  | 默认 `15000`；组合决策总期限，不适用于纯 Jev                                |
| `REASONING_INPUT_PRICE_PER_MILLION`  | 标准 provider 输入价格预留估算，按实际定价核对                              |
| `REASONING_OUTPUT_PRICE_PER_MILLION` | 标准 provider 输出价格预留估算，按实际定价核对                              |

组合策略实验需要显式记录 provider、型号、thinking、超时与费用配置；这些可选变量不启用纯 Jev 的额外分析调用。DeepSeek 使用独立输入、缓存命中和输出价格；官方峰值估算见[验证记录](verification.md)。首次请求后最多重试 3 次，受共同的 Hybrid deadline 限制，不保证用完次数。

`responses` 使用 `POST /v1/responses` 与 Bearer 鉴权；`messages` 使用 `POST /v1/messages`、`x-api-key` 和 Anthropic 版本头。这是模型 HTTP 协议，不是 OpenPoker webhook。

模型名按供应商实际支持的标识配置。`.env.example` 的默认模型名和保守价格参数不等于代理商的支持或价格承诺。响应实际模型与请求不一致时，默认作为 `reasoning_model_mismatch` 拒绝，不把代理替换的模型算作指定模型验证成功。

```sh
npm run bot -- --strategy jev-reasoning --max-hands 10 --max-minutes 30
```

记录保留分析模式、实际分析、供应商实际返回的思考摘要、Jev 最终选择、请求/实际模型、各次调用状态及用量；adaptive 模式另记录 Jev 路由判断。供应商未返回思考文本时明确标记缺失，不补写。供应商兼容性、身份、费用和延迟以真实探针/运行证据为准；mock 测试只证明客户端行为。

## 回放与评估

Recorded replay 重现实际事件、当时可见信息和执行结果。Decision replay 让另一个策略处理同一冻结快照，不把原收益赋给新行动。

网站 Experiments 只展示已保存且允许公开的结果。创建免费 baseline 比较使用服务器 CLI：

```sh
npm run evaluate -- --demo --run demo-jev --strategy baseline --limit 20
```

先运行一次 Demo 生成数据库，再关闭服务执行 CLI。正式历史数据使用实际 Run ID 替换 `RUN_ID`：

```sh
npm run evaluate -- --run RUN_ID --strategy baseline --limit 20
npm run evaluate -- --run RUN_ID --strategy jev --limit 20
npm run evaluate -- --run RUN_ID --strategy jev-reasoning --limit 20
```

后两种策略调用真实模型并计费。服务运行时可通过受保护的内部 API 创建评估，保持单进程写入；离线 CLI 评估前关闭使用同一数据库的服务。网页不触发任何评估或模型调用。

只读 Demo 不能创建评估，但可以浏览已保存结果。需要公开展示实验时，先在本地合成 Demo 中生成结果，再发布该只读数据集。

## 访问控制与公开演示

网页面向匿名访客，只执行读取，不提供登录、令牌输入、Bot 启停、配置修改、Demo 重置或实验触发。浏览器不保存或发送 `API_TOKEN`，模型分析与模型调用只在后端进行。

公开真实观战设置 `PUBLIC_HISTORY=true`，并在 `.env` 配置独立 `API_TOKEN`。同源 `GET /api/live` SSE 更新公共牌、Bot 自己的当前手牌、座位、筹码、底池、行动玩家及决策阶段，并自动重连。流使用 `snapshot` 事件和每 15 秒一次的注释心跳；`GET /api/live/decisions` 提供本手已保存的决策分析与 session 记录。所有访客读取相同展示数据；未公开的对手底牌、合法行动授权及鉴权凭据不公开。网站是否打开不影响 Bot 的运行。

已结束牌局可匿名读取完整已记录的事件、底牌和当时的决策。结束判定以手牌 `status=complete` 为准，收益未完成核对的结束牌局也可查看并保留未核对标识。当前手的已保存决策通过上述 Live 会话接口实时查看；完整历史归档仍按结束状态筛选。公开数据移除 turn token、鉴权及账户秘密；统计与历史随后台运行异步刷新。匿名 `/api/evaluations` 仅发布整份结果中所有决策都属于已结束牌局的实验，包含进行中手牌的整份结果暂不公开。

`API_TOKEN` 保留为内部管理 API 的 Bearer 凭证，Compose 管理脚本从容器环境读取。无令牌写请求被拒绝，错误令牌返回 401。公网 Nginx 模板只允许 GET/HEAD，管理请求从服务器本机或容器内执行，不经过公共域名。内部完整查询和写入权限不改变网站只读定位。

非 loopback 监听必须配置至少 24 字符的 `API_TOKEN`，或开启 `READ_ONLY_DEMO=true`。静态页面和 `/health` 可以响应；未启用 `PUBLIC_HISTORY` 且配置了令牌时，匿名访问受保护 API 返回 401，网页不能通过输入令牌解锁。需要公开展示时启用真实观战模式，或使用下面的合成只读 Demo。

```sh
npm run build
HOST=0.0.0.0 READ_ONLY_DEMO=true DEMO_DATABASE_PATH=data/public-demo.sqlite node dist/cli/serve.js
```

此模式禁用写请求、真实 Runtime 和模型凭据；不需要服务器上的供应商 Key。

## SQLite 持久化、备份与恢复

数据库位于 `DATABASE_PATH`。WAL 模式可能同时存在主 `.sqlite`、`-wal` 和 `-shm` 文件，把整个目录置于可写持久卷，更新代码或重建容器时保留该目录。

不要只复制运行中的主文件。Compose 部署在服务运行时执行：

```sh
sh scripts/manage.sh backup
sh scripts/manage.sh resume
```

管理脚本通过 `docker compose exec` 使用容器内 Node.js SQLite online backup，在 `/app/data/backups/` 创建一致副本，再通过 `docker compose cp` 复制到宿主机 `data/backups/`。备份含敏感运行数据，默认宿主目录位于 Git 忽略的 `data/` 下，应限制访问，不公开上传。

本地 Node.js 部署可直接执行同类在线备份：

```sh
node --input-type=module <<'JS'
import { mkdirSync, chmodSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
mkdirSync('data/backups', { recursive: true, mode: 0o700 });
const destination = `data/backups/jev-${Date.now()}.sqlite`;
const db = new DatabaseSync('data/jev.sqlite', { readOnly: true });
try {
  await backup(db, destination);
  chmodSync(destination, 0o600);
  console.log(`Backup created: ${destination}`);
} finally {
  db.close();
}
JS
```

替换源路径为实际数据库位置。恢复步骤：

1. 停止 Bot 及所有访问原数据库的进程；Compose 部署先执行 `sh scripts/manage.sh stop`，等待离桌确认及服务停止。
2. 将原主文件、同名 WAL/SHM 一起移入受限归档目录，不覆盖唯一原件。
3. 将一致备份复制到 `DATABASE_PATH`，设置服务用户可读写权限，不把旧 WAL/SHM 放回副本旁。
4. 暂设 `AUTO_START_BOT=false` 后启动控制台，核对 Run、决策、结算和费用；Compose 部署使用 `sh scripts/manage.sh start`。参赛前确认没有其他实例连接该 Bot，再恢复所需启动配置。

恢复旧备份也会回退本地费用账本，但供应商实际消费不会回退；需要结合外部账户与当前牌桌核对，不能把恢复视为额度重置。

## Docker Compose

仓库的多阶段 [Dockerfile](../Dockerfile) 使用 Node.js 24，生产镜像仅装生产依赖，以非 root `node` 用户运行。已在本地 Docker Engine 验证构建、只读 Demo、HTTP 健康、写入禁用、UID 1000 和持久卷重启；实际服务器配置与验证见[部署手册](deployment.md)及[验证报告](verification.md)。

克隆仓库或下载源码，保留 [compose.yaml](../compose.yaml)、`.env.example` 和 `scripts/`。在部署目录创建 `.env`，配置独立 `API_TOKEN` 和供应商凭据后启动；服务器无需另外安装 Node.js。

```sh
cp -n .env.example .env
chmod 600 .env
# 编辑 .env 后启动。
sh scripts/manage.sh start
sh scripts/manage.sh status
```

统一管理入口如下，内部的容器操作全部使用 `docker compose`：

```sh
sh scripts/manage.sh start
sh scripts/manage.sh stop
sh scripts/manage.sh restart
sh scripts/manage.sh update
sh scripts/manage.sh status
sh scripts/manage.sh logs
sh scripts/manage.sh backup
sh scripts/manage.sh resume
```

`start` 使用配置的镜像，默认是 `hewenyulucky/jev-card-agent:latest`，首次缺少镜像时自动拉取；发现已有运行实例时保持容器不变，配置调整通过 `restart` 或 `update` 生效。`stop`、`restart`、`update` 先请求正常停止，等待当前手牌结束并通过平台 REST 确认离桌；无法确认时不继续停止或替换容器。`restart` 使用本地镜像，`update` 才显式拉取配置标签的最新镜像并重建。旧 `scripts/update-container.sh` 入口保留并转交 `manage.sh update`。`logs` 显示最近 100 行并持续跟踪，Ctrl+C 只退出日志查看。

正常排空默认无时间上限；Compose 的 150 秒停止宽限期用于已排空服务的退出，不是当前手牌的最长时限。不要直接替换仍在打牌的容器。`backup` 为在线一致备份，输出默认复制到宿主机 `data/backups/`。

宿主端口默认只绑定 loopback，外部访问通过 HTTPS 反向代理。秘密在容器启动时注入；`.dockerignore` 排除 `.env` 与本地运行数据，凭据不进入镜像。`jev-card-agent-data` 命名卷保存数据库，启动、重启和更新均保留该卷。

正式观战部署在 `.env` 设置 `PUBLIC_HISTORY=true`、`AUTO_START_BOT=true`，后台在服务启动后自动参赛。无凭据只读演示可在独立部署环境设置 `READ_ONLY_DEMO=true`、`DEMO_DATABASE_PATH=/app/data/demo.sqlite`，沿用同一管理入口；不要让 Demo 和真实服务同时占用同一宿主端口或共用数据库。

GitHub Actions 在检查通过后无缓存构建并自动发布镜像，服务器更新始终由操作者手动执行 `update`。健康检查失败不会自动拉取新镜像。完整配置与域名接入见[服务器部署手册](deployment.md)。

## 自动检查与验证边界

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

检查包括 lint、格式、类型、单元/集成测试、构建、1,000 行限制与凭据卫生。Playwright 另启 `8788` 的生产 Demo，验证页面和真实本地 API/SQLite 的交互，无需真实凭据。GitHub Actions 使用相同流程，并安装浏览器系统依赖。

已实际执行生产构建、本地浏览器端到端流程、移动布局、Jev/OpenPoker 连接探针及 Docker 构建/持久化重启。真实 Arena 验收、推理接口兼容性、服务器部署与全部检查结果见[验证报告](verification.md)。

指标口径见[评估文档](evaluation.md)，实现边界见[架构](architecture.md)和[接入决定](transports.md)。

## harness 运行、长期记忆与会话复盘

本次复盘后的更新保留全部已有历史和费用账本，不清空数据库。新版以独立 Run 和明确的代码、上下文版本重新采样；旧版 fallback 样本按实际决策来源单独分析，不作为新版全部动作来自 Jev 的证据。

当前 Bot 使用 `BOT_STRATEGY=jev`，由 Jev 根据 [harness](harness.md) 提供的牌型、下注数学、位置、按街候选与历史对手证据作最终选择。纯 Jev 不调用 DeepSeek、GPT 或 Claude；无法及时取得有效 Jev 结果时记录失败、不提交本地动作并停牌。实际运行时间、动作来源、净收益和验证状态见验证记录，不把配置或模型连通当作盈利证明。

每手一个本地持久 session，同手不同动作有独立 decisionId 与 turn。完整原始上下文和历史持久保存；实际 Jev 请求使用精简投影，保留当前行动、最多 6 个同手先前选择及活跃对手证据，移除无关近期输赢和重复标识。`opponent_encounters` 首次惰性回填旧结算，再按事件游标增量更新，每人最多 200 个已完成交手；结算和接收都须早于决策。只有完整匹配的行动元数据才用于价格/尺寸分母，不把未知当成零。公开摊牌是有偏样本，不是完整范围。组合策略的分析会话仍最多 12 次，每回合 4000 字符、合计 12,000 字符；完整文本另存。

当前版本为 `visible-context-v6`、`street-sized-raise-to-v2`、`opponent-encounters-v3` 与 `poker-harness-choice-v5`。后续改动保留版本、来源和信息截止，在冻结样本上比较行为与可靠性，并以新 Run 的真实净收益验证效果。均匀随机范围摊牌参考只保留用于审计，实际 Jev 请求移除该字段；它不等于对手下注范围胜率，历史收益不能套给替代行动。当前服务不在线自动改写策略。

Jev 与推理服务默认均为首次调用后最多重试 3 次，每次尝试独立计费和记录。重试仅用于临时网络错误、限流、服务端错误、单次超时或无效响应；鉴权、供应商余额、模型不匹配或账本失败不盲目重试。所有尝试共享当前行动期限，不延长 OpenPoker 窗口，也不重复提交下注。取消或失败后仍保留已经完成的分析及已知调用记录。

按所有者的公开演示要求，实时页面展示 Bot 当前手牌、决策处理阶段及本手已保存的决策复盘。历史中保留分析、供应商实际返回的思考摘要、Jev 最终选择和调用记录；供应商未返回思考文本时显示未提供，不补写。网页不能改策略或触发新调用。
