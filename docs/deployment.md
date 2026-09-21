# Docker 服务器部署

镜像通过 GitHub Actions 的 `DOCKER` 环境自动构建并发布到 `hewenyulucky/jev-card-agent`。环境 Secrets 为 `USER`、`TOKEN`；参见[镜像发布流程](docker-release.md)。镜像支持 `linux/amd64` 和 `linux/arm64`。构建明确禁用 Docker 和 npm Actions 缓存，并拉取最新基础镜像。CI 不连接运行服务器、不自动更新正在运行的容器。

服务器只需要 Docker Engine 和 Docker Compose。使用独立目录保存仓库中的 `compose.yaml` 和本地 `.env`，目录权限建议 700，`.env` 权限 600。不要将 `.env` 上传至 GitHub 或放入镜像。

## 首次启动

将 `scripts/update-container.sh` 同时放入服务器的 `scripts/` 目录。在服务器目录准备 `.env`，填入 OpenPoker、Jev 凭据和独立 `API_TOKEN`。沿用 `.env.example` 中的预算配置。设置：

```dotenv
BIND_ADDRESS=127.0.0.1
CONSOLE_PORT=8787
AUTO_START_BOT=true
BOT_STRATEGY=jev-reasoning
REASONING_API_FORMAT=messages
REASONING_MESSAGES_MODEL=claude-opus-5
REASONING_TIMEOUT_MS=30000
HYBRID_TIMEOUT_MS=40000
```

`BIND_ADDRESS` 决定宿主机监听地址。默认仅本机；也可设为服务器的私有 VPN 地址，在同一网络内访问。公网访问应在认证控制台前配置 HTTPS 反向代理。镜像中的应用监听 `0.0.0.0:8787`，SQLite 位于专用持久卷。

```sh
docker compose pull
docker compose up -d
docker compose ps
```

`AUTO_START_BOT=true` 会在服务启动后自动连接并参赛，关闭后只启动控制台。首次开启前停止同账号的其他 Bot；数据库租约只协调同一持久数据库。控制台 Access settings 使用 `API_TOKEN`，不是供应商 API Key。

## 手动更新 latest

先确认 GitHub 的镜像发布工作流成功，再在服务器部署目录执行：

```sh
sh scripts/update-container.sh
docker compose logs --tail 50 app
```

该脚本由操作者手动执行：先通过受保护 API 请求停止，持续等待当前牌局结束，再用 OpenPoker REST 确认已离桌，然后拉取镜像并重建容器。正常更新不设置强制结束当前手牌的时间限制；状态无法核实时退出，保留旧容器。不要用直接 `docker compose up` 替换仍在打牌的实例。仓库没有 Watchtower、定时拉取或 CI SSH 部署。自动启动配置决定新容器是否恢复参赛。

`latest` 是可变标记。部署前可记录 `docker image inspect hewenyulucky/jev-card-agent:latest --format '{{index .RepoDigests 0}}'`；需要固定版本或回退时，在 `.env` 设置 `JEV_IMAGE=hewenyulucky/jev-card-agent:sha-完整提交号`，再手动执行 pull/up。`JEV_IMAGE` 不会覆盖持久数据。

## 数据与运行

`jev-card-agent-data` 卷保存 SQLite 主文件及 WAL/SHM，更新容器时保留。不要执行 `docker compose down -v`，除非明确要删除全部运行数据。备份与恢复方法见[运行手册](running.md#sqlite-持久化备份与恢复)。费用账本随数据库保留；模型预算不足会采用合法 fallback，不自动充值。

`docker compose stop` 停止服务；`docker compose up -d` 使用已有本地镜像启动，不主动拉取新版。健康检查只表示 HTTP 可响应，Bot 实际连接与错误查看控制台或日志。公开日志前移除私有运行标识和牌局信息。

## 域名与 Nginx

为公网域名配置 A/AAAA 到服务器或前置 CDN，Nginx 单独创建该域名的 server block，代理至 `127.0.0.1:8787`，转发 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。使用 Let's Encrypt webroot 获取证书，HTTP 重定向至 HTTPS，保留 ACME challenge 路径用于续期。

```dotenv
BIND_ADDRESS=127.0.0.1
PUBLIC_HISTORY=true
```

公开访问只读已结束的牌局历史；匿名请求不返回进行中的底牌或管理能力。管理者在 HTTPS 页面 Access settings 中输入独立 `API_TOKEN`。原始 SQLite 和原始 turn token 不公开下载；公开 API 对完整已结束牌局的协议事件和决策快照进行凭据脱敏。

仓库提供实际使用的 [Nginx 配置](../deploy/nginx.conf)，其中仅有公开域名和本机反代地址。复制到其他服务器前将域名及证书路径替换成自己的，并先通过仅监听 80 端口的 ACME webroot 站点申请证书。证书存在后安装完整配置：

```sh
sudo install -m 644 deploy/nginx.conf /etc/nginx/sites-available/openpoker.zve.ccwu.cc
sudo ln -sfn /etc/nginx/sites-available/openpoker.zve.ccwu.cc /etc/nginx/sites-enabled/openpoker.zve.ccwu.cc
sudo nginx -t && sudo systemctl reload nginx
```

单独保存该域名配置，先执行 `nginx -t` 再 reload，保留服务器其他站点。证书续期可自动执行；容器镜像更新仍只通过手动 drain/pull/up 流程执行。

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

TLS 与应用健康分别验收：证书和跳转正常时，后端尚未启动仍可能返回 502；容器启动后 `/health` 应返回 200，公开历史与管理员权限还需通过应用 API 单独检查。原始证书私钥、SSH 配置和服务器地址不进入公开仓库。
