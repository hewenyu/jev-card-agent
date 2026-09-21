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

也可以下载仓库源码后进入解压目录执行后两条命令。已有 `.env` 应保留，不要覆盖。在 `.env` 中填入 OpenPoker、Jev 凭据和独立 `API_TOKEN`，沿用样例中的预算配置。组合策略还需填写推理服务地址与凭据。设置：

```dotenv
BIND_ADDRESS=127.0.0.1
CONSOLE_PORT=8787
PUBLIC_HISTORY=true
AUTO_START_BOT=true
BOT_STRATEGY=jev-reasoning
REASONING_API_FORMAT=messages
REASONING_MESSAGES_MODEL=claude-opus-5
REASONING_TIMEOUT_MS=30000
HYBRID_TIMEOUT_MS=40000
```

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

## 域名与 Nginx

为公网域名配置 A/AAAA 到服务器或前置 CDN，Nginx 单独创建该域名的 server block，代理至 `127.0.0.1:8787`，转发 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。使用 Let's Encrypt webroot 获取证书，HTTP 重定向至 HTTPS，保留 ACME challenge 路径用于续期。

```dotenv
BIND_ADDRESS=127.0.0.1
PUBLIC_HISTORY=true
```

公开网站匿名展示实时公共牌、座位、筹码、底池和行动流，使用 SSE 自动更新并重连。当前私有底牌、合法行动授权和未完成决策保留在后台；已结束牌局提供完整已记录的脱敏历史与决策复盘。原始 SQLite 和原始 turn token 不公开下载。Jev、推理模型、密钥与自动运行配置都由后端管理，页面只执行读取。

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
