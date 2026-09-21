# Docker 服务器部署

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

也可以下载仓库源码后进入解压目录执行后两条命令。已有 `.env` 应保留，不要覆盖。在 `.env` 中填入 OpenPoker、Jev、独立 `DEEPSEEK_API_KEY` 和内部 `API_TOKEN`，保留既有预算账本与限制。所有者已选择 DeepSeek-V4.1-Flash 关闭 thinking 作为本轮部署目标；以下是目标配置，实际上线完成时间与集成证据见[验证报告](verification.md)，不能把配置说明当成上线验收。

```dotenv
BIND_ADDRESS=127.0.0.1
CONSOLE_PORT=8787
PUBLIC_HISTORY=true
AUTO_START_BOT=true
BOT_STRATEGY=jev-reasoning
REASONING_MODE=always
REASONING_PROVIDER=deepseek
DEEPSEEK_API_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING=disabled
REASONING_TIMEOUT_MS=10000
REASONING_MAX_OUTPUT_TOKENS=4096
HYBRID_TIMEOUT_MS=40000
JEV_TIMEOUT_MS=3000
```

`REASONING_PROVIDER=deepseek` 选择专用 Messages provider，不读取标准 provider 的凭据作为备用。官方请求 ID 是 `deepseek-flash`，不是自行构造的版本名称。`DEEPSEEK_THINKING=disabled` 显式关闭思考，请求不发送 `output_config.effort`；旧环境即使保留 `REASONING_EFFORT=high` 也不会开启 thinking。`always` 仍表示每次有效决策先请求分析，再由 Jev 选择最终合法行动。

DeepSeek 分析单次超时 10 秒，首次之后最多重试 3 次；Jev 单次超时 3 秒，同样最多重试 3 次。所有尝试共享 40 秒 Hybrid deadline 和持久费用预算，不保证可以用完全部重试。分析失败时只由 Jev 在剩余时间内继续，必要时采用合法本地 fallback；GPT 与 Claude 不作为自动兜底，也不会因 DeepSeek 失败自动切换 provider。

标准 provider 的 Responses / Messages 支持仍保留用于另行配置的对照实验，其 `REASONING_API_FORMAT`、`REASONING_MODEL`、`REASONING_MESSAGES_MODEL` 在本目标下不决定实际模型。专用配置与保守峰值计费见[接入合同](transports.md#deepseek-messages-专用合同)。关闭思考后返回的分析可以用于 Jev 决策，但不称为 thinking 返回或 high 思考成功。

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

## 数据与运行

`jev-card-agent-data` 卷保存 SQLite 主文件及 WAL/SHM，更新容器时保留。不要执行 `docker compose down -v`，除非明确要删除全部运行数据。备份与恢复方法见[运行手册](running.md#sqlite-持久化备份与恢复)。费用账本随数据库保留；模型预算不足会采用合法 fallback，不自动充值。

日常停止、启动和重启使用上述管理入口。健康检查只表示 HTTP 可响应，Bot 实际连接与错误查看控制台或日志。公开日志前移除私有运行标识和牌局信息。`backup` 使用运行中容器内的 Node.js SQLite online backup 写入 `/app/data/backups/`，再通过 `docker compose cp` 复制到宿主机；备份默认保存于被 Git 忽略的 `data/backups/`，包含敏感记录，不公开上传。

账户筹码由服务器读取官方 `season/me` 并统一刷新，浏览器只读后端快照。运维核对时区分 Account available（离桌余额）、Account at table（REST 在桌快照）、Seat stack（WebSocket 当前座位筹码）与 Net result（已核实手牌净收益）；REST 与牌桌事件的更新时间不同，不能要求两种在桌数值始终相等。请求失败保留最后值并标记过期，不清零余额，不用历史收益推算余额。先检查快照更新时间和连接状态，不能仅因数值不同就重启 Bot 或重复补筹。

自动补筹每次为 1,500 免费虚拟筹码，条件是离桌、无在桌筹码且离桌余额小于 1,000；首次立即可用，此后 Free 冷却 5 分钟、Pro 冷却 2 分钟。补筹确认后重新核对官方余额，再按实际可用额入队；确认事件不等于入桌成功。页面只在收到明确截止信息时显示补筹倒计时，未知时不假设可以立即补筹。补筹增加余额但不增加历史 Net result；服务重启不重置官方冷却或本地模型费用账本。完整口径见[运行手册](running.md#账户筹码牌桌筹码与自动补筹)。

补筹和冷却事件随 SQLite 持久卷与备份保留，更新或重启后可恢复已记录资金历史与最后已知状态。核对补筹时查看事件、官方确认余额和随后的账户快照；缺失的补筹前余额保持未知，不能由当前余额倒推。不要清空资金记录来解决页面刷新问题，补筹流水也不会计入已结算手牌的净收益。

### 经明确要求开始全新运行

如所有者明确要求清空历史并重新开始，应先完成新镜像验证与发布，等待旧 Bot 当前手牌结束、由官方 REST 确认离桌，再停止 Compose 服务。创建权限为 `600` 的一致数据库备份后，离线清理旧 Run、牌局、决策、行动、原始事件、评估和资金展示记录，同时清除牌桌恢复检查点、旧 session 来源、活动 Run 标记及已停止进程的租约。不能仅清空页面列表而保留会重新恢复旧桌的检查点。

模型 `usage` 与 `provider_usage` 账本必须保留，清理前后累计费用及未知请求预留保持一致；清理历史不增加剩余模型额度。备份留在服务器私有目录，不通过公开网站访问。清理操作只在服务停止后的运维环境执行，不提供公开写接口；只启动已验证的新镜像，确认新 Run、新牌桌状态及新产生的历史，官方账户余额和补筹冷却由服务端重新同步。此操作不删除 OpenPoker 官方持有的账户或比赛记录。

## 域名与 Nginx

为公网域名配置 A/AAAA 到服务器或前置 CDN，Nginx 单独创建该域名的 server block，代理至 `127.0.0.1:8787`，转发 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。使用 Let's Encrypt webroot 获取证书，HTTP 重定向至 HTTPS，保留 ACME challenge 路径用于续期。

```dotenv
BIND_ADDRESS=127.0.0.1
PUBLIC_HISTORY=true
```

公开网站匿名展示公共牌、Bot 自己的当前手牌、座位、筹码、底池和行动流，使用 SSE 自动更新并重连。按所有者要求，当前手的决策阶段及已保存分析通过只读接口同步展示；已结束牌局保留完整已记录的脱敏历史与决策复盘。未公开的对手底牌、合法行动授权、鉴权凭据及原始 SQLite 不公开下载。本轮目标每次先请求关闭 thinking 的 DeepSeek Flash 分析，再由 Jev 选择；密钥、模型配置与自主运行都由后端管理，页面只执行读取。

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
