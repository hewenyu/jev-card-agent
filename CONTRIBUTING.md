# 参与开发

本项目使用 Node.js 24、TypeScript、React、Fastify 和 Node.js 内置 SQLite，以单 package 组织代码。重点是自动对局、执行可靠性和完整决策证据。

## 安装与运行

```sh
node --version
npm ci
npm run demo
```

Node.js 应为 `24.x`。Demo 无需 API Key，使用合成数据。开发模式使用 `npm run dev`；配置与生产运行方式见[运行手册](docs/running.md)。

`.env.example` 只保存占位值，真实配置放入已被 Git 忽略的 `.env`。普通本地测试与 CI 使用 mock HTTP/WebSocket 和临时 SQLite，不需要真实模型或平台凭据。

## 代码组织

| 目录                      | 职责                                     |
| ------------------------- | ---------------------------------------- |
| `src/core/`               | 状态、可见上下文、合法候选和对手统计     |
| `src/openpoker/`          | WebSocket/REST 适配与协议校验            |
| `src/policies/`           | Jev、baseline、推理分析与组合策略        |
| `src/runtime/`            | 生命周期、行动期限、恢复、幂等与降级     |
| `src/storage/`            | SQLite、Trace、查询、费用预留和合成 Demo |
| `src/evaluation/`         | 冻结决策快照的比较                       |
| `src/server/`、`src/cli/` | HTTP 应用、控制接口和运行入口            |
| `src/shared/`             | 前后端共享类型                           |
| `web/`                    | React 控制台及本地静态资源               |
| `tests/`、`tests/e2e/`    | 单元/集成验证及 Playwright 用户流程      |

按职责拆分模块。每个维护文本文件不得超过 1,000 行，包括源码、测试、配置和文档。不要压缩手写语句或关闭检查来绕过限制。自动生成的 `package-lock.json` 采用紧凑 JSON，内容仍由 npm 管理。

## 提交前检查

```sh
npm run format
npm run check
npx playwright install chromium
npm run test:e2e
```

Linux CI 使用 `npx playwright install --with-deps chromium` 安装浏览器系统依赖。首次安装依赖和浏览器可能需要联网；测试本身不访问付费 API 或正式入队。

`npm run check` 依次执行 ESLint（零 warning）、Prettier、TypeScript、Vitest 单元/集成测试、生产构建及仓库检查。Playwright 另行构建并在 `8788` 启动本地 `--demo` 服务，使用独立数据库；该端口应空闲。失败时查看 `test-results/` 中的 trace。

`npm run format` 在格式化后执行 `scripts/compact-lock.mjs`。更改依赖后提交 `package.json` 和 lockfile 的实际变更，不手工重写包解析结果。

## 测试与评审

- 协议变更验证重复事件、当前行动权、同 ID 同 payload、恢复后的未决动作及回合过期。
- 决策变更验证候选合法性、raise-to 总额语义、超时降级、迟到响应和费用记录。
- Replay/对手模型变更验证信息截止，后续底牌、统计和结算不得进入过去的输入。
- 统计变更区分牌局利润、补充筹码、盲注归一化和官方排行榜。
- UI 变更验证真实交互、错误/空状态、移动布局、访问控制及数据来源标识。
- SQLite 变更验证事务、唯一约束、重启恢复及一致备份。

测试验证可观察结果与故障条件，保留有效断言；不靠跳过失败用例或修改无关行为制造通过。真实外部服务与免费本地检查分别报告。

## 真实服务与秘密

`npm run diagnose` 检查平台鉴权；显式模型探针和 Jev 决策重跑会调用付费 API；`npm run bot` 会正式入队。使用有权使用的凭据，配置费用/时间/手数限制，并确认没有另一个 Runtime 控制同一 Bot。

公开 PR、日志、截图和 fixture 不得包含 API Key、鉴权头、控制台 token、私人账户信息或私有牌局标识。不要提交本地数据库、WAL/SHM、运行数据或浏览器 sessionStorage。

架构、运行、评估和脱敏验证文档属于公开交付，保留在 `docs/` 并从 [README 文档索引](README.md#文档)链接。个人服务器的地址、SSH 用户/私钥、实际部署参数及原始探针报告放在已忽略的 `data/deployment/` 或仓库外，公开部署手册使用占位值。`.gitignore` 和 `.dockerignore` 分别控制 Git 与镜像构建上下文；检查两者，不能假定一个会自动继承另一个。

## PR 说明

说明具体问题、改变后的行为、实际执行的检查和已知限制。区分本地 mock、真实 API、真实 Arena 和 Docker/服务器部署证据；未运行的检查明确标注。UI 可附无秘密的 Demo 截图，协议变更附脱敏最小样例。

架构、命令或配置变化时同步更新 README、运行手册及相关文档，确认相对链接存在。
