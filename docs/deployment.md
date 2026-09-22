# Docker 服务器部署

> 1.3.0 adds the independently configured async LLM advice layer; see [async research](async-llm.md) for off/shadow/live, immutable archives, private publication and three-database backup. Earlier deterministic-only descriptions below document the retained statistics path.

镜像通过 GitHub Actions 的 `DOCKER` 环境自动构建并发布到 `hewenyulucky/jev-card-agent`。环境 Secrets 为 `USER`、`TOKEN`；参见[镜像发布流程](docker-release.md)。镜像支持 `linux/amd64` 和 `linux/arm64`。构建明确禁用 Docker 和 npm Actions 缓存，并拉取最新基础镜像。CI 不连接运行服务器、不自动更新正在运行的容器。

服务器只需要 Docker Engine 和 Docker Compose，无需安装 Node.js。克隆仓库或下载源码，在部署目录保留 `compose.yaml`、`.env.example` 和 `scripts/`，本地创建 `.env`。目录权限建议 700，`.env` 权限 600。管理脚本内部的容器操作全部使用 `docker compose`；不要将 `.env` 上传至 GitHub 或放入镜像。

## 首次启动

首次准备部署目录：

```sh
git clone https://github.com/hewenyu/jev-card-agent.git
cd jev-card-agent
cp -n .env.example .env
chmod 600 .env
```

也可以下载仓库源码后进入解压目录执行后两条命令。已有 `.env` 保留，不要覆盖。在 `.env` 中填写 `OPEN_POKER_API_KEY`、`JEV_API_KEY` 与内部 `API_TOKEN`，保留费用账本，并设置 Jev 单次请求 10 秒、整次决策 40 秒。费用只记录，不按金额限制调用。当前实现为纯 Jev [harness](harness.md)；以下配置说明不代表新版已部署或已经盈利，实际发布时间与证据见[验证报告](verification.md)。

```dotenv
BIND_ADDRESS=127.0.0.1
CONSOLE_PORT=8787
PUBLIC_HISTORY=true
AUTO_START_BOT=true
BOT_STRATEGY=jev
JEV_TIMEOUT_MS=10000
JEV_DECISION_TIMEOUT_MS=40000
```

`BOT_STRATEGY=jev` 让 Jev 根据当前局面与有界上下文直接选择合法行动，不请求 DeepSeek 或其他分析模型。首次调用后最多重试 3 次，共享 40 秒决策期限及平台行动期限，每次请求最多 10 秒。每个提交动作必须来自有效 Jev 结果；失败时不提交本地动作，记录诊断并持久停牌。移除旧配置中的 `RUN_BUDGET_USD` 和 `TOTAL_BUDGET_USD`，它们不再是运行配置。

`AUTO_START_BOT=true` 在服务就绪且不存在持久失败停牌时自动开始 Run，不限制手数或时长，启用 auto-rebuy。新版通过牌型/下注工具、按街候选和长期对手记忆辅助 Jev；均匀随机摊牌参考仅留作审计、不发送给 Jev。完整原始牌局及决策保存在原持久卷；不根据短期输赢自动改写策略。冻结输入对照与真实盈利评估见[评估文档](evaluation.md)。

### 可选分析模型

只有另行决定开展组合策略实验时，才设置 `BOT_STRATEGY=jev-reasoning` 并配置分析 provider。DeepSeek 需独立 `DEEPSEEK_API_KEY`，使用 `REASONING_PROVIDER=deepseek`、官方地址 `https://api.deepseek.com/anthropic` 与 `DEEPSEEK_MODEL=deepseek-flash`。`DEEPSEEK_THINKING=disabled` 关闭 thinking，也不发送 effort；`REASONING_MODE=always` 表示每次先分析、再由 Jev 选择。分析超时和 Hybrid 总期限应显式按实验配置记录，不套用于纯 Jev。标准 Responses / Messages 适配器同样保留为显式实验选项，不作自动兜底。完整合同见[接入说明](transports.md#deepseek-messages-专用合同)。

### 监听与启动

`BIND_ADDRESS` 决定宿主机监听地址。默认仅本机；也可设为服务器的私有 VPN 地址，在同一网络内访问。公开只读网站通过 HTTPS 反向代理提供访问。镜像中的应用监听 `0.0.0.0:8787`，SQLite 位于专用持久卷。

```sh
sh scripts/manage.sh start
sh scripts/manage.sh status
```

`AUTO_START_BOT=true` 会在服务启动后自动连接并参赛，关闭后只启动展示服务。首次开启前停止同账号的其他 Bot；数据库租约只协调同一持久数据库。`API_TOKEN` 仅用于服务器内部管理 API，由 Compose 排空脚本从容器环境读取；网页不接收或发送此令牌。`PUBLIC_HISTORY=true` 开放匿名实时观战和已结束历史。

默认镜像为 `hewenyulucky/jev-card-agent:latest`。`start` 在本地缺少镜像时自动拉取；已有镜像时不会主动更新，正在运行的服务也不通过 `start` 替换。

## 一键管理

所有命令在部署目录执行：

| 命令                           | 行为                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `sh scripts/manage.sh start`   | 启动服务，首次自动拉取缺失镜像                         |
| `sh scripts/manage.sh stop`    | 等待当前手牌结束并确认离桌，然后停止服务               |
| `sh scripts/manage.sh restart` | 同样先排空，再用本地镜像重新启动服务                   |
| `sh scripts/manage.sh update`  | 同样先排空，显式拉取配置标签的最新镜像并重建服务       |
| `sh scripts/manage.sh resume`  | 排除模型故障后显式恢复，按当前配置开始新 Run           |
| `sh scripts/manage.sh status`  | 查看 Compose 服务状态                                  |
| `sh scripts/manage.sh logs`    | 查看最近 100 行日志并持续跟踪，Ctrl+C 退出查看         |
| `sh scripts/manage.sh backup`  | 在线创建一致 SQLite 备份并复制到宿主机 `data/backups/` |

`stop`、`restart`、`update` 都先通过受保护 API 请求停止，持续等待当前牌局结束，再用 OpenPoker REST 确认已离桌。正常排空不设置强制结束当前手牌的时间限制；状态无法核实时退出，不继续停止或替换容器。容器的 150 秒停止宽限期用于已排空服务的退出，不是当前手牌的最长时限。

## 手动更新 latest

先确认 GitHub 的镜像发布工作流成功，再在服务器部署目录执行：

```sh
sh scripts/manage.sh update
sh scripts/manage.sh logs
```

更新由操作者手动执行。不要用直接 `docker compose up` 替换仍在打牌的实例。仓库没有 Watchtower、定时拉取或 CI SSH 部署。自动启动配置决定新容器是否恢复参赛。旧入口 `sh scripts/update-container.sh` 保留兼容，转交 `manage.sh update` 执行同一流程。

`latest` 是可变标记。需要固定版本或回退时，在 `.env` 设置 `JEV_IMAGE=hewenyulucky/jev-card-agent:sha-完整提交号`，再手动执行 `sh scripts/manage.sh update`。也可按镜像发布记录配置 digest。`JEV_IMAGE` 不会覆盖持久数据。

## 模型失败后的恢复

模型失败停牌持久化在同一数据库中；`AUTO_START_BOT=true`、容器重启或手动镜像更新都不会绕过它。HTTP 网站继续只读展示历史和故障状态。排除供应商真实欠费、鉴权或服务故障后，在部署目录执行 `sh scripts/manage.sh resume`，由容器内带内部令牌调用 `POST /api/runtime/resume`，按当前配置启动新 Run。公网代理不开放此写接口。停止失败的模型调用后，平台可能自行处理未提交的超时回合，应保留该事实而非记为 Jev 决策。

## 数据与运行

`jev-card-agent-data` 卷保存 SQLite 主文件及 WAL/SHM，更新容器时保留。不要执行 `docker compose down -v`，除非明确要删除全部运行数据。备份与恢复方法见[运行手册](running.md#sqlite-持久化备份与恢复)。费用账本随数据库保留，仅记录费用，不阻止调用。真实模型失败或无有效 Jev 选择会停牌；未知费用记录不会被当作欠费，也不会生成本地 fallback 动作。

日常停止、启动和重启使用上述管理入口。健康检查只表示 HTTP 可响应，Bot 实际连接与错误查看控制台或日志。公开日志前移除私有运行标识和牌局信息。`backup` 使用运行中容器内的 Node.js SQLite online backup 分别为原始库及已有知识库写入 `/app/data/backups/`，再通过 `docker compose cp` 复制到宿主机；备份默认保存于被 Git 忽略的 `data/backups/`，包含敏感记录，不公开上传。两份备份各自一致，不宣称具有同一跨库原子时刻；原始库保留已固定的完整知识绑定。

### 长期记忆与历史统计迁移

旧版 `visible-context-v6` 的 `opponent_encounters` 派生表保留兼容。新版慢循环在独立知识数据库中按事件游标处理历史并发布，实时路径不再惰性回填；原 Run、手牌、原始事件、请求、资金与费用表不清理。无需为了创建长期记忆重置数据库。双时间截止限制历史查询，旧数据也只能在当时已经收到且已结束后进入记忆。

以下是从更早版本迁移错街 checkpoint 统计的历史操作；已完成该修正的部署不必重复。先更新宿主机 `scripts/`，备份并安全离桌，再离线重建：

```sh
sh scripts/manage.sh backup
sh scripts/manage.sh stop
docker compose pull app
docker compose run --rm --no-deps -T --entrypoint node app --input-type=module < scripts/rebuild-opponents.mjs
sh scripts/manage.sh start
```

脚本按原始 live events 重放，只替换 checkpoint 中的对手累计统计及迁移标记，保留牌桌状态、历史请求、决策、结算与费用账本。有有效运行租约或未结束手牌时拒绝执行；相同事件水位可重复执行。新安装没有旧 checkpoint，无需运行此迁移。以后常规更新使用 `manage.sh update`。

账户筹码由服务器读取官方 `season/me` 并统一刷新，浏览器只读后端快照。运维核对时区分 Account available（离桌余额）、Account at table（REST 在桌快照）、Seat stack（WebSocket 当前座位筹码）、Season score（官方 `score`）与 Net result（已核实手牌净收益）；REST 与牌桌事件的更新时间不同，不能要求两种在桌数值始终相等。当前 Run 的 Overview 与 Live 采用同一官方积分快照；历史 Run 标记为历史观测，旧版余额求和只标记估算。请求失败保留最后值并标记过期，不清零余额，不用历史收益推算余额。每次部署验证 `startup`、`before_join`、`table_joined` 的账户快照，正常停牌还应保存 `after_leave` 最终对账，再核对官方积分与公开展示。先检查所选 Run、快照更新时间和连接状态，不能仅因数值不同就重启 Bot 或重复补筹。

自动补筹每次为 1,500 免费虚拟筹码，条件是离桌、无在桌筹码且离桌余额小于 1,000；首次立即可用，此后 Free 冷却 5 分钟、Pro 冷却 2 分钟。补筹确认后重新核对官方余额，再按实际可用额入队；确认事件不等于入桌成功。页面只在收到明确截止信息时显示补筹倒计时，未知时不假设可以立即补筹。补筹增加余额但不增加历史 Net result；服务重启不重置官方冷却或本地模型费用账本。完整口径见[运行手册](running.md#账户筹码牌桌筹码与自动补筹)。

补筹和冷却事件随 SQLite 持久卷与备份保留，更新或重启后可恢复已记录资金历史与最后已知状态。核对补筹时查看事件、官方确认余额和随后的账户快照；缺失的补筹前余额保持未知，不能由当前余额倒推。不要清空资金记录来解决页面刷新问题，补筹流水也不会计入已结算手牌的净收益。

### 经明确要求开始全新运行

本次复盘后的部署必须保留现有全部历史与费用账本，以新 Run 和版本标识区分修正前后的数据，不执行清库。以下清理流程仅在将来再次明确要求清理时适用，不能把以前某次授权当作每次更新都清库。

获得此类明确授权后，应先完成新镜像验证与发布，等待旧 Bot 当前手牌结束、由官方 REST 确认离桌，再停止 Compose 服务。创建权限为 `600` 的一致数据库备份后，离线清理旧 Run、牌局、决策、行动、原始事件、评估和资金展示记录，同时清除牌桌恢复检查点、旧 session 来源、活动 Run 标记及已停止进程的租约。不能仅清空页面列表而保留会重新恢复旧桌的检查点。

模型 `usage` 与 `provider_usage` 账本必须保留，清理前后累计费用及未知请求预留保持一致；这些记录仅用于费用追溯，不用于限制新调用。备份留在服务器私有目录，不通过公开网站访问。清理操作只在服务停止后的运维环境执行，不提供公开写接口；只启动已验证的新镜像，确认新 Run、新牌桌状态及新产生的历史，官方账户余额和补筹冷却由服务端重新同步。此操作不删除 OpenPoker 官方持有的账户或比赛记录。

## 域名与 Nginx

为公网域名配置 A/AAAA 到服务器或前置 CDN，Nginx 单独创建该域名的 server block，代理至 `127.0.0.1:8787`，转发 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。使用 Let's Encrypt webroot 获取证书，HTTP 重定向至 HTTPS，保留 ACME challenge 路径用于续期。

```dotenv
BIND_ADDRESS=127.0.0.1
PUBLIC_HISTORY=true
```

公开网站匿名展示公共牌、Bot 自己的当前手牌、座位、筹码、底池和行动流，使用 SSE 自动更新并重连。按所有者要求，当前手的决策阶段及已保存分析通过只读接口同步展示；已结束牌局保留完整已记录的脱敏历史与决策复盘。未公开的对手底牌、合法行动授权、鉴权凭据及原始 SQLite 不公开下载。本轮目标由 Jev 直接从合法候选中选择；密钥、模型配置与自主运行都由后端管理，页面只执行读取。

HTTPS 代理的 `location /` 使用 `limit_except GET { deny all; }`，允许 GET 及隐含允许的 HEAD，拒绝公网管理写请求，即使携带有效内部令牌也不会放行。`proxy_buffering off` 使 SSE 及时到达浏览器；`GET /api/live` 发送 `snapshot` 事件，后端每 15 秒发送注释心跳，代理读超时维持 60 秒。Compose 管理脚本从容器内访问受保护 API，不经过公网代理，因此仍可安全排空和更新。

仓库提供 [Nginx 配置模板](../deploy/nginx.conf)，其中仅有公开域名和本机反代地址。复制到其他服务器前将域名及证书路径替换成自己的，并先通过仅监听 80 端口的 ACME webroot 站点申请证书。证书存在后安装完整配置：

```sh
sudo install -m 644 deploy/nginx.conf /etc/nginx/sites-available/openpoker.zve.ccwu.cc
sudo ln -sfn /etc/nginx/sites-available/openpoker.zve.ccwu.cc /etc/nginx/sites-enabled/openpoker.zve.ccwu.cc
sudo nginx -t && sudo systemctl reload nginx
```

单独保存该域名配置，先执行 `nginx -t` 再 reload，保留服务器其他站点。证书续期可自动执行；容器镜像更新仍只通过手动 `sh scripts/manage.sh update` 执行。

### TLS 配置与续期

公开站点 [openpoker.zve.ccwu.cc](https://openpoker.zve.ccwu.cc) 使用独立 Nginx 站点，HTTPS 代理至宿主机 `127.0.0.1:8787`。HTTP 的 `/.well-known/acme-challenge/` 保留给 `/var/www/letsencrypt` webroot，其他 HTTP 请求重定向至 HTTPS。转发包含原始 Host、客户端转发链和 HTTPS 协议标识；不公开容器端口。

域名前置 Cloudflare，浏览器验证的是 CDN 边缘证书；Nginx 源站另使用 Let's Encrypt 证书。源站证书于 2026-09-21 签发，有效至 2026-12-20；后续日期以实际续期结果为准。CDN 到源站应使用 Full (strict) TLS，保持回源证书校验。

证书由 Certbot webroot 模式管理，`certbot.timer` 负责定期检查续期。专用 deploy hook 仅在本域名证书续期后执行 `nginx -t` 和 `systemctl reload nginx`，不触发 Bot 重启或镜像更新。手动检查：

```sh
sudo nginx -t
systemctl is-enabled certbot.timer
systemctl is-active certbot.timer
sudo certbot renew --cert-name openpoker.zve.ccwu.cc --dry-run
curl --head https://openpoker.zve.ccwu.cc/health
```

TLS 与应用健康分别验收：证书和跳转正常时，后端尚未启动仍可能返回 502；容器启动后 `/health` 应返回 200，匿名实时流、已结束历史可读，以及公网写请求被拒绝还需单独检查。内部管理能力通过服务器本机入口检查。原始证书私钥、SSH 配置和服务器地址不进入公开仓库。

## 双循环更新核对

仍通过无缓存 GitHub 镜像构建、人工 `manage.sh update` 和 Docker Compose 更新；等待当前手结束并由官方确认离桌，不能同时启动同账号本地 Bot。原始库与新增派生知识库均放在持久数据卷，更新前备份；不清理旧历史、费用或每手知识绑定。

新容器启动后分别核对 HTTP 健康、Bot 已接受的 Jev 动作和慢循环状态。HTTP 健康不等于研究进程正常。公开 Live 下方可观察积压与最近完成时间，决策详情可查看固定知识和异步审计；检查 worker 落后时是否继续用已有版本、下一手才使用新发布版本。没有历史字段的旧决策应显示未记录，不能静默回填成旧模型依据。

回滚使用经过验证的镜像并走相同安全离桌流程，保留所有数据和发布记录。知识回滚只影响未来手选择，不能改变已固定手或历史实际请求。具体部署证据和测量结果写入验证记录，不能以构建成功替代线上核对。
