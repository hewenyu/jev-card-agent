# Docker 镜像自动发布

本仓库的默认分支是 `master`，远程仓库为 `hewenyu/jev-card-agent`。GitHub Actions 在验证通过后，将双架构镜像发布到 Docker Hub：

```text
hewenyulucky/jev-card-agent
```

镜像包含 `linux/amd64` 和 `linux/arm64`。发布流程定义在 [docker.yml](../.github/workflows/docker.yml)，使用现有 [Dockerfile](../Dockerfile)。模型凭据、运行数据库和 `.env` 不进入镜像。

## GitHub Environment 配置

在仓库 **Settings → Environments** 创建名为 **DOCKER** 的 Environment，并添加两个 Environment secrets：

| Secret  | 内容                                                              |
| ------- | ----------------------------------------------------------------- |
| `USER`  | 有权向 `hewenyulucky/jev-card-agent` 推送镜像的 Docker Hub 用户名 |
| `TOKEN` | 该用户的 Docker Hub access token，具有目标仓库的写入权限          |

这两个 Secret 只提供给发布 Job，检查 Job 不需要 Docker Hub 或模型凭据。工作流的 GitHub token 仅申请 `contents: read`，不会修改仓库或创建 GitHub Release。

如果 Environment 配置了审核人，发布 Job 会等待 GitHub 的 Environment 审核。如果配置了部署分支限制，应允许 `master` 和需要发布的 `v*` 标签；手动运行其他分支也必须满足该限制。

## 触发与标签

| 触发条件                                | 发布标签                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| push 到 `master`                        | `latest`、`sha-<完整 commit SHA>`                                              |
| push 稳定版本标签，例如 `v1.2.3`        | `1.2.3`、`latest`、`sha-<完整 commit SHA>`                                     |
| push 预发布版本标签，例如 `v1.3.0-rc.1` | `1.3.0-rc.1`、`sha-<完整 commit SHA>`，不更新 `latest`                         |
| Actions 页面手动运行                    | 总是生成 SHA 标签；运行默认分支时更新 `latest`，版本标签按上述 SemVer 规则处理 |

`v*` 是事件筛选条件，版本标签应使用合法的 SemVer，例如 `v1.2.3`。不符合 SemVer 的标签只保留 SHA 镜像标签，不应作为正式版本发布。SHA 标签用于追踪同一提交；如需固定某次实际构建内容，部署时使用镜像 digest，因为重新构建相同提交也可能更新基础镜像或构建元数据。

`latest` 只由默认分支或稳定版本标签发布。手动运行非默认开发分支不会覆盖 `latest`。GitHub Actions 不会因为 Pull Request 自动推送镜像；Pull Request 仍由原有检查工作流验证。

## 发布前的检查

`check` Job 在 Node.js 24 上依次执行：

1. `npm ci`。
2. `npm run check`，包括 lint、格式、类型、单元与集成测试、生产构建和仓库检查。
3. 安装 Playwright Chromium 及系统依赖。
4. `npm run test:e2e`，使用本地合成数据和真实应用服务验证界面。

`publish` Job 声明 `needs: check`，检查失败时不登录 Docker Hub、不构建推送发布镜像。检查通过后，QEMU 和 Buildx 构建两个架构，登录 Docker Hub 并发布多架构 manifest。每次构建设置 `no-cache: true` 和 `pull: true`，不读取/写入 BuildKit 缓存，也不启用 npm Actions 缓存；始终重新获取基础镜像并按 lockfile 安装依赖。

默认测试不会加入 OpenPoker Arena，也不调用付费模型。工作流会将最终镜像 digest 和标签写入 Actions Job Summary，便于部署时核对。

## 服务器更新由操作者手动执行

CI 的职责到 Docker Hub 镜像发布为止。它不通过 SSH 连接服务器，不修改服务器上的容器，不配置 Watchtower，也不自动拉取或重启部署。

服务器更新时，操作者先确认目标标签或 digest、持久化数据目录和访问配置，再按[运行手册](running.md)更新容器。更新正在打牌的实例前，先请求正常停止并确认离桌，保留 SQLite 数据卷；不要让旧容器与新容器同时使用同一个 Bot API Key。

例如可先检查目标镜像的架构和 digest：

```sh
docker buildx imagetools inspect hewenyulucky/jev-card-agent:latest
```

一次 Actions 执行成功后，仍需核对 Docker Hub 的标签与 digest；服务器部署成功需要独立验证容器状态、健康检查及持久卷。静态工作流检查通过不代表镜像已经发布或服务器已经更新。
