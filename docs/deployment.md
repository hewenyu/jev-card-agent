# Docker 服务器部署与 2.0.0 迁移

本文描述部署操作，不代表 2.0.0 已上线。本次重构交付 PR，未替换生产容器、
未启动第二个真实 Bot、未清理线上历史。[验证报告](duelloop-refactor-verification.md)
区分实际执行与后续运维检查。

## 自动构建，手动更新

GitHub Actions 的 `DOCKER` 环境使用 `USER`、`TOKEN` Secrets，自动检查并发布
`hewenyulucky/jev-card-agent` 的 `linux/amd64`、`linux/arm64` 镜像。构建禁用缓存，
拉取新基础镜像。CI 不通过 SSH 更新运行中的服务器。

服务器使用 Docker Engine 和 Docker Compose。部署目录保留 `compose.yaml`、
当前 `scripts/` 及私有 `.env`；目录权限建议 700，`.env` 为 600。所有容器管理
使用 Compose，不使用 `docker run`。模型凭据不进入镜像、仓库或公开浏览器。

```sh
git clone https://github.com/hewenyu/jev-card-agent.git
cd jev-card-agent
cp -n .env.example .env
chmod 600 .env
```

已有配置不得覆盖。默认镜像标签 `latest` 可变；固定发布可配置完整镜像 digest
或不可变 commit 标签。源码和服务器配置必须属于同一待部署版本。

## 先迁移配置，再允许参赛

真实实时入口只接受 `BOT_STRATEGY=jev`。它使用 DuelLoop 的真实 Jev Score 链路，
不再调用旧同步 Hybrid，也不再消费旧 advice 发布器。

```dotenv
BIND_ADDRESS=127.0.0.1
CONSOLE_PORT=8787
PUBLIC_HISTORY=true
AUTO_START_BOT=false
BOT_STRATEGY=jev
JEV_MODEL=jev-1.13.0
JEV_TIMEOUT_MS=10000
JEV_DECISION_TIMEOUT_MS=40000
DUELLOOP_EXECUTION_RESERVE_MS=1500
FACTS_ENABLED=true
DUELLOOP_RESEARCH_ENABLED=false
```

保留 `OPEN_POKER_API_KEY`、`JEV_API_KEY` 和独立内部 `API_TOKEN`。为受控账户选择
稳定 `DUELLOOP_ACTOR_ID`、`DUELLOOP_SCOPE_ID`；重启不能改成新身份绕过旧 intent。
默认决策总时限 40 秒包含准备和提交预留，仍受原始 Arena 行动权限限制。
初次 Jev 请求后最多三次重试；无有效结果时不生成本地动作。金额没有预算门槛。

删除退役的 `ASYNC_LLM_*`、`LLM_ADVICE_*`、`LLM_RESEARCH_*`、`REASONING_MODE` 和
`HYBRID_TIMEOUT_MS` 运行配置；真实启动检测这些旧值会明确报错。旧研究数据库路径
`RESEARCH_DATABASE_PATH` 用于历史只读展示，不用于启动旧发布器。DeepSeek 凭据可
继续作为新研究的来源；研究控制改用 `DUELLOOP_RESEARCH_*`，不把旧 live/auto
模式静默转换为自动策略激活。

默认数据库位于持久卷中：

| 数据                                                 | 默认路径（Compose 中）                               |
| ---------------------------------------------------- | ---------------------------------------------------- |
| 原始牌局、应用执行 journal/outbox、资金与用量        | `/app/data/jev.sqlite`                               |
| 确定性事实与审计                                     | `/app/data/jev.sqlite.facts.sqlite`                  |
| DuelLoop 决策、release、intent、feedback、研究与验证 | `/app/data/jev.sqlite.duelloop.sqlite`               |
| 旧知识/研究归档                                      | 原路径保留，供历史读取                               |
| 新开发与最终评价协议                                 | `/app/data/protocols/development.json`、`final.json` |

自定义路径必须落在持久存储内，各库不能相同，包括符号链接别名。数据库 schema
由对应存储模块管理。原始历史不会转换成虚假的 Score 记录，也不会因迁移清空。
已有未知动作先对账；旧失败停牌不得通过改配置或换库自动绕过。

`migrate:duelloop` 输出的 `.env.next` 是宿主机路径，不能交给本仓库的
`compose.yaml` 使用。迁移副本应使用工具同时生成的独立 `compose.json` 与
`.env.compose`：五个数据库和两个协议都映射到 `/app/data`，唯一数据挂载是
迁移目录的 `working/`，不会混入原 `jev-card-agent-data` 卷。默认只监听
`127.0.0.1:18787`，Bot/研究自动启动关闭，并用迁移操作者 UID/GID 访问 0600
私有文件。先安全停止旧服务、复核镜像 digest 与 manifest，再按
[迁移流程](duelloop-migration.md) 启动；不要把两个 Compose 文件合并。

## 准备私有评价协议

研究默认关闭，发布默认为 explicit。先确定实验的独立样本数、每 seed 手数、
改善/退化阈值、置信水平和延迟门槛，再生成协议；不要看过最终结果才调整阈值。
下面变量由操作者根据审阅过的计划设置，不是已证明有统计功效的默认值。

```sh
sh scripts/manage.sh research --op prepare-protocols --output /app/data/protocols \
  --seed-blocks "$SEED_BLOCKS" --hands-per-seed "$HANDS_PER_SEED" \
  --min-samples "$MIN_SAMPLES" --minimum-improvement "$MIN_IMPROVEMENT" \
  --max-group-regression "$MAX_REGRESSION" --confidence "$CONFIDENCE" \
  --max-latency-ms "$MAX_LATENCY_MS"
```

该操作不调用模型、不参赛，使用新随机种子并生成互不重叠的 development/final
分区，拒绝覆盖已有文件。保持 final 种子私有；研究工具只能读公开阈值和协议
摘要，不能读取 final seeds。最终 holdout 使用次数耗尽后，需要新的独立协议。

配置 `DUELLOOP_RESEARCH_API_KEY` 或已有 `DEEPSEEK_API_KEY`，精确模型
`deepseek-flash`，端点 `https://api.deepseek.com/anthropic`；默认关闭思考，启用
时 effort 默认 high。同时保留 Jev key，独立评价会真实调用 Jev。设置
`DUELLOOP_RESEARCH_ENABLED=true` 后安全重启。协议缺失/无效时研究显示
`waiting_protocol`，不反复重启 worker，Bot 可继续使用已有 release。

## Compose 管理与安全替换

| 命令                                | 行为                                 |
| ----------------------------------- | ------------------------------------ |
| `sh scripts/manage.sh start`        | 启动缺失服务，不替换正在运行的容器   |
| `sh scripts/manage.sh stop`         | 完成本手、确认官方离桌，再停止       |
| `sh scripts/manage.sh restart`      | 相同排空流程，用已有镜像重建         |
| `sh scripts/manage.sh update`       | 相同排空流程，拉取配置镜像并重建     |
| `sh scripts/manage.sh resume`       | 排除故障后通过私有入口明确恢复 Bot   |
| `sh scripts/manage.sh status`       | 查看 Compose 状态                    |
| `sh scripts/manage.sh logs`         | 查看并持续跟踪日志                   |
| `sh scripts/manage.sh backup`       | 一致 SQLite 备份，复制到私有宿主目录 |
| `sh scripts/manage.sh research ...` | 在现有服务中执行私有研究控制 CLI     |

更新前确认 GitHub 检查和镜像发布成功，同步当前管理脚本，核对磁盘空间、备份
和镜像身份，再人工执行。不要直接 `docker compose up` 替换仍在打牌的服务。
排空等待当前手结束，然后由 OpenPoker REST 确认离桌；无法确认时停止更新。
150 秒容器退出宽限期不是强制终止一手牌的时限。

```sh
sh scripts/manage.sh backup
sh scripts/manage.sh update
sh scripts/manage.sh status
sh scripts/manage.sh logs
```

首次迁移保留 `AUTO_START_BOT=false`，完成恢复和运行核对后再明确恢复。持续运行
可设置 `AUTO_START_BOT=true`，无手数/时长上限并启用 auto-rebuy；已有持久失败
不会被 auto-start 或容器重启绕过。不要同时启动本地和服务器同账户 Bot。

## 备份与回滚

更新保留 `jev-card-agent-data` 卷。不要执行 `docker compose down -v`。SQLite
online backup 包含已提交 WAL；不要只复制活跃主文件。发布备份应先安全离桌并
暂停派生写入，然后核对备份清单包含原始、facts、DuelLoop 和存在的旧归档。
各数据库备份分别一致，不宣称跨数据库同一原子时刻。私有评价协议文件也需保留。

备份位于被 Git 忽略的私有目录，文件权限 600，不能上传至公开网站。先在隔离
副本验证 `PRAGMA quick_check`、手级绑定与执行 outbox 恢复，再允许生产替换。
不得仅凭 HTTP 200 或一个镜像构建成功宣称恢复验证完成。

策略回滚通过 SDK 操作，仅改变未来未绑定的手：

```sh
sh scripts/manage.sh research --op status
sh scripts/manage.sh research --op pause
sh scripts/manage.sh research --op cancel --run RUN_ID
sh scripts/manage.sh research --op approve --release RELEASE_DIGEST --actor OPERATOR --reason REVIEW_REASON
sh scripts/manage.sh research --op rollback --release PRIOR_RELEASE_DIGEST --actor OPERATOR --reason REVIEW_REASON
```

暂停研究不等于取消当前任务；暂停激活不等于停止 Bot。`pause-activation` 与
`resume-activation` 也需 `--actor` 和 `--reason`。公开代理不允许这些写请求。

程序回滚使用通过验证的旧镜像及其兼容数据库副本，仍需完成当前手和官方离桌。
不能让旧程序直接写入它不支持的新 schema，也不能删掉未知 intent 来解除阻断。
保留回滚前后的所有证据和失败原因。

## 部署后核对

依次确认镜像 revision、HTTP 健康、只读权限、当前 hand/release/facts 绑定、
真实 Jev 接受动作及无重复/过期提交。研究状态、facts 进度和 Bot 连接分别检查；
研究等待协议不应被误判成实时停牌。批准新版本后核对下一手才使用新 release，
当前手不混版本，历史实际输入不被后续审计覆盖。

账户信息以官方 `season/me` 为准，入桌前先核对，入桌/离桌/rebuy 后再次刷新。
区分离桌账户余额、REST 在桌快照、WS 座位可用筹码、当街下注与赛季积分。当前
Run 的 Overview 与 Live 共用官方积分快照；旧估算历史标明来源。失败刷新保留
旧值并标 stale，不用零或历史净收益反推余额。

免费 rebuy 1,500 虚拟筹码不计入牌局盈利；首次立即，此后 Free 五分钟、Pro
两分钟冷却，条件为离桌、无在桌筹码且离桌余额低于 1,000。确认后重新读取官方
余额再入队，记录资金事件，不在前端简单加筹码。

## 域名与 Nginx

为公网域名配置 A/AAAA 到服务器或前置 CDN，Nginx 单独创建该域名的 server block，代理至 `127.0.0.1:8787`，转发 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。使用 Let's Encrypt webroot 获取证书，HTTP 重定向至 HTTPS，保留 ACME challenge 路径用于续期。

```dotenv
BIND_ADDRESS=127.0.0.1
PUBLIC_HISTORY=true
```

公开网站匿名展示公共牌、Bot 自己的当前手牌、座位、筹码、底池和行动流，使用 SSE 自动更新并重连。按所有者要求，当前手的决策阶段及已保存分析通过只读接口同步展示；已结束牌局保留完整已记录的脱敏历史与决策复盘。未公开的对手底牌、合法行动授权、鉴权凭据及原始 SQLite 不公开下载。本版本由 Jev Score 与固定 release 的选择规则确定合法候选；密钥、模型配置与自主运行都由后端管理，页面只执行读取。

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
