# 运行与部署手册

本手册对应实际 Node.js 命令、环境变量和控制接口。默认策略是纯 Jev，实时游戏连接使用 OpenPoker WebSocket V2。Demo、历史回放和真实 Arena 数据分别标识。

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
| `JEV_TIMEOUT_MS`           | `3000`，纯 Jev 调用/决策预算                                  |
| `TOTAL_BUDGET_USD`         | `9`，当前数据库记录的累计模型预算                             |
| `RUN_BUDGET_USD`           | `1`，未由启动参数覆盖时的单 Run 预算                          |
| `HOST`、`PORT`             | `127.0.0.1`、`8787`                                           |
| `DATABASE_PATH`            | `data/jev.sqlite`；生产持久化路径                             |
| `DEMO_DATABASE_PATH`       | `data/demo.sqlite`；演示路径                                  |
| `API_TOKEN`                | 内部管理 API 凭证；非只读 Demo 的公开监听必需，至少 24 个字符 |
| `READ_ONLY_DEMO`           | `false`；设为 `true` 后使用合成数据，禁止写请求和真实运行     |
| `PUBLIC_HISTORY`           | `false`；设为 `true` 后匿名开放实时公共观战和已结束历史       |
| `AUTO_START_BOT`           | `false`；设为 `true` 后，HTTP 监听成功时自动启动一次 Bot      |
| `BOT_STRATEGY`             | `jev`；自动启动策略，允许 `baseline`、`jev-reasoning`         |

`OPENPOKER_API_KEY`、`OPENPOKER_WS_URL`、`OPENPOKER_REST_URL` 作为兼容别名保留；同时配置时优先 `OPEN_POKER_*`。

费用是用量与配置单价的估算，不是账户余额或供应商账单。取消/失败而用量未知的调用保留费用预留，不假定失败免费。费用账本随数据库保存；复制新库或删除旧库会分离账本，不能据此重新获得已经消费的额度。

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

填写 `OPEN_POKER_API_KEY`、`JEV_API_KEY` 与内部 `API_TOKEN`，设置 `AUTO_START_BOT=true`、`BOT_STRATEGY=jev`、`PUBLIC_HISTORY=true`，执行 `npm run build`、`npm run start`。服务启动后自动参赛，网页仅展示状态。策略、模型、预算和自动启动配置保存在后台。

无界面入口：

```sh
npm run bot -- --strategy jev --max-hands 10 --max-minutes 30 --budget-usd 1 --buy-in 2000
```

该命令会正式入队、匹配、自动决策和结算。不要同时用同一 Bot 启动其他 Runtime。单数据库 lease 防止重复本地控制，不能协调另一数据库或另一台机器上的 Bot。

| 参数               | 含义                                           |
| ------------------ | ---------------------------------------------- |
| `--strategy jev`   | 默认纯 Jev；另支持 `baseline`、`jev-reasoning` |
| `--max-hands 10`   | 达到手数后停止；默认 `0` 不按手数限制          |
| `--max-minutes 30` | 时长上限；默认 `0` 不按时长限制                |
| `--budget-usd 1`   | 单 Run 模型费用限制                            |
| `--buy-in 2000`    | 虚拟筹码买入；当前平台范围 1,000–5,000         |
| `--no-auto-rebuy`  | 关闭默认启用的自动补充虚拟筹码                 |

手数、时长分别是停止条件，不保证指定时间内匹配并完成足够手数。两者均 `0` 时持续参赛，仍受模型预算、平台状态和明确停止影响。

首次 `SIGINT`/`SIGTERM` 请求在手牌边界优雅停止，默认不设等待上限；第二次信号请求强制离桌。Compose 部署使用 `sh scripts/manage.sh stop` 等待手牌完成并确认离桌后停止服务。更新代码或迁移数据前先停止 Bot，并确认 Runtime 已停止且平台已离桌，再关闭服务；单手可能超过容器的停止宽限期，不应以强杀容器代替正常排空。

默认重启控制台服务不会自动开始新 Run。重新执行 Bot 命令或启用自动启动时会检查实际牌桌并恢复状态，不把旧回合建议直接提交到新回合。baseline 无 Jev 费用，但仍参加真实 OpenPoker 对局。

服务器需要在容器重启后恢复自主参赛时，设置 `AUTO_START_BOT=true`、`BOT_STRATEGY=jev`，保留同一持久数据库。HTTP 监听成功后会调用一次正常的 Bot 启动流程：买入 `2000`、启用 auto-rebuy、不限制手数和时长，单 Run 模型预算使用 `RUN_BUDGET_USD`，累计预算仍使用持久账本。启动失败会输出错误、关闭 HTTP 服务并以失败状态退出，由容器重启策略处理。Demo 和只读 Demo 即使设置此开关也不会自动参赛。CLI 的手数、时长和费用限制仍按指定启动参数生效。

此开关只控制进程启动后的参赛，不下载或更新镜像。服务器镜像更新由部署者手动执行 `sh scripts/manage.sh update`，脚本先等待当前手牌结束并确认离桌，再通过 Compose 拉取和重建；不要安装自动更新镜像的服务。

需要由进程管理器自动重启的本地无界面服务，可在构建后使用 `node --env-file-if-exists=.env dist/cli/bot.js --strategy jev --budget-usd 1` 作为启动命令。该命令启动即参赛，默认不限手数/时长。Docker 部署使用下文的 Compose 管理入口和 `AUTO_START_BOT`，保留控制台及管理 API。模型累计预算随持久数据库保留；同一账号只运行一个实例。

## Jev 与推理模型组合

默认始终是纯 Jev。先保留纯 Jev 运行记录，再比较组合策略，两个策略使用不同 Run。

组合流程：**Jev 初始合法选择及路由 → 按需调用推理分析 → Jev 从原合法候选集重新选择 → Runtime 校验并提交**。推理模型只提供建议和简短可观察依据，没有动作提交权。

Jev 不要求分析、剩余时间不足、分析或重新决策失败时，保留仍可用的初始 Jev 选择；整体过期的结果由 Runtime 拒绝并执行合法降级。

| 变量                                 | 含义                                         |
| ------------------------------------ | -------------------------------------------- |
| `REASONING_API_KEY`                  | 独立推理服务凭据                             |
| `REASONING_API_BASE_URL`             | 服务根地址或 `/v1` 地址；HTTPS，本地测试除外 |
| `REASONING_API_FORMAT`               | `responses` 或 `messages`                    |
| `REASONING_MODEL`                    | Responses 请求模型名                         |
| `REASONING_MESSAGES_MODEL`           | Messages 请求模型名                          |
| `REASONING_TIMEOUT_MS`               | 默认 `12000`，分析期限                       |
| `HYBRID_TIMEOUT_MS`                  | 默认 `15000`，组合决策总期限                 |
| `REASONING_INPUT_PRICE_PER_MILLION`  | 输入价格预留估算，按服务实际定价核对         |
| `REASONING_OUTPUT_PRICE_PER_MILLION` | 输出价格预留估算，按服务实际定价核对         |

`responses` 使用 `POST /v1/responses` 与 Bearer 鉴权；`messages` 使用 `POST /v1/messages`、`x-api-key` 和 Anthropic 版本头。这是模型 HTTP 协议，不是 OpenPoker webhook。

模型名按供应商实际支持的标识配置。`.env.example` 的默认模型名和保守价格参数不等于代理商的支持或价格承诺。响应实际模型与请求不一致时，默认作为 `reasoning_model_mismatch` 拒绝，不把代理替换的模型算作指定模型验证成功。

```sh
npm run bot -- --strategy jev-reasoning --max-hands 10 --max-minutes 30 --budget-usd 1
```

记录保留 Jev 路由结果、请求/实际模型、各次调用状态及用量。供应商兼容性、身份、费用和延迟以真实探针/运行证据为准；mock 测试只证明客户端行为。

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

公开真实观战设置 `PUBLIC_HISTORY=true`，并在 `.env` 配置独立 `API_TOKEN`。实时观战通过同源 `GET /api/live` SSE 更新公共牌、座位、筹码、底池、行动玩家和公开行动流，并自动重连。流使用 `snapshot` 事件和每 15 秒一次的注释心跳，所有订阅者收到同样的公共投影；当前私有底牌、合法行动授权、模型请求和未完成决策不会公开。网站是否打开不影响 Bot 的运行。

已结束牌局可匿名读取完整已记录的事件、底牌和当时的决策。结束判定以手牌 `status=complete` 为准，收益未完成核对的结束牌局也可查看并保留未核对标识。进行中手牌的历史详情与决策仍不可匿名查询。公开数据移除 turn token、鉴权及账户秘密；统计与历史随后台运行异步刷新。匿名 `/api/evaluations` 仅发布整份结果中所有决策都属于已结束牌局的实验，包含进行中手牌的整份结果暂不公开。

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
