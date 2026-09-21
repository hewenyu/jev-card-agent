# jev-card-agent

An autonomous poker agent and decision-model evaluation platform powered by Jev, competing against real bots on OpenPoker.ai.

基于 **Node.js 24 + TypeScript** 的自主扑克 Agent 与决策评估控制台。通过 OpenPoker.ai WebSocket V2 参加 6-max No-Limit Texas Hold’em，记录每次决策的输入快照、候选行动、模型结果和执行确认。

OpenPoker 提供游戏服务器、匹配和结算；本项目负责 Agent 的持续运行、决策、恢复和评估。最终接入方式为自托管 WebSocket Bot。

## 本地演示

```sh
npm ci
npm run demo
```

需要 Node.js `24.x`。打开 **http://127.0.0.1:8787**。演示无需 API Key，不加入真实比赛，也不调用付费模型；它构建前后端并以合成数据启动完整应用，默认使用 `data/demo.sqlite`。

- **Overview**：按 Run 查看已结算收益、bb/100、决策数和费用估算。
- **Live table**：观察牌桌及 Runtime 状态，配置策略、时长、手数和费用上限。
- **Replay & decisions**：逐事件回放，检查当时输入、候选分布、动作及执行确认。
- **Experiments**：在冻结的历史决策快照上进行策略比较，追溯具体差异。

界面区分 **Demo / Recorded / Live Arena**。合成战绩不进入真实收益，历史结果不能代表替代动作的收益，Jev 选项概率也不是扑克胜率。

历史按每页 100 条增量读取。通过 **Load older runs** 选择早期运行，在 Replay 中使用 **Load older hands** 继续查看较早牌局；不会一次下载全部长期历史。结果筛选作用于已加载牌局，Overview 曲线明确标注已加载样本，顶部收益指标覆盖整个 Run。启用公开历史模式后，访客仅能读取服务端允许公开的已完成记录，运行控制仍需访问令牌。

## 真实 Bot

```sh
cp -n .env.example .env
chmod 600 .env
```

在本地 `.env` 填写 `OPEN_POKER_API_KEY` 和 `JEV_API_KEY`，不要提交该文件。独立的控制台访问令牌使用 `API_TOKEN`。

```sh
# 检查平台鉴权，不加入匹配队列
npm run diagnose

# 正式入队并自动打牌；默认策略为纯 Jev
npm run bot -- --strategy jev --max-hands 10 --max-minutes 30 --budget-usd 1
```

也可以执行 `npm run build` 和 `npm run start`，在 Live table 中显式点击 **Start live run**。控制台默认不自动入队；服务器可配置 `AUTO_START_BOT=true`、`BOT_STRATEGY=jev`，在进程重启后使用持久数据库恢复参赛。`npm run bot` 是独立无界面入口，同一个数据库和 Bot 选择一种运行入口。

真实 Jev 请求产生费用。手数、时长和费用限制分别生效；这些停止上限不保证在指定时间内完成指定手数。

策略包括 `jev`、本地规则 `baseline` 和显式启用的 `jev-reasoning`。组合模式由 Jev 判断是否请求推理分析，再由 Jev 从原合法候选集重新决策。默认仍用纯 Jev，先运行纯 Jev 并保留记录，再据此比较组合模式。配置与模型身份校验见[运行手册](docs/running.md#jev-与推理模型组合)。

## 开发与检查

```sh
npm run dev
```

Vite 默认界面地址为 `http://127.0.0.1:5173`，以终端输出为准；API 默认监听 `127.0.0.1:8787`。生产构建由单个 Node.js 应用提供界面、API 和单 Bot Runtime，SQLite WAL 保留运行数据。

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`check` 包括 ESLint、格式、类型、单元/集成测试、生产构建和仓库行数/凭据检查。浏览器测试使用独立合成数据库，验证概览、历史回放、baseline 实验和移动端交互；默认检查无需真实凭据，不消费模型额度。

每个维护文本文件不超过 **1,000 行**。`package-lock.json` 保持标准 lockfile 数据的紧凑 JSON 格式，`npm ci` 可直接使用；`npm run format` 会恢复紧凑形式。

## 部署与证据

[运行手册](docs/running.md) 包含生产启动、只读公开 Demo、访问控制、Docker、SQLite 一致备份与恢复。密钥、数据库、WAL 文件与私有对局数据不进入公开源码。

生产构建、真实本地 API/SQLite 浏览器测试、Docker 构建、非 root 容器运行与持久卷重启均已验证。真实 Arena、模型接口和服务器部署的具体证据及限制以[验证报告](docs/verification.md)和[服务器部署手册](docs/deployment.md)为准。镜像发布可以通过 CI 自动完成，运行中的服务器只在手动执行更新流程后替换镜像。

## 文档

- [完整架构与验收范围](docs/architecture.md)
- [评估、测试与费用控制](docs/evaluation.md)
- [接入调研与决定](docs/transports.md)
- [运行、配置、备份与部署](docs/running.md)
- [服务器部署与手动更新](docs/deployment.md)
- [Docker 镜像自动发布](docs/docker-release.md)
- [实际验证与限制](docs/verification.md)
- [参与开发](CONTRIBUTING.md)

以上设计、协议、运行和验证文档随公开仓库提交。真实 `.env`、SSH 凭据、服务器地址清单、原始牌局与部署操作记录保存在忽略的 `data/` 或其他私有存储中；公开文档只使用通用步骤和脱敏结论。

协议来源：[OpenPoker Docs](https://docs.openpoker.ai/)、[TypeSafe API](https://docs.typesafe.ai/api)。
