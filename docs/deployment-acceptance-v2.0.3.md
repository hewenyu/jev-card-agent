# v2.0.3 部署验收

2026-09-26 已完成生产更新。本文时间均为 UTC，运行验收采样时间为 **01:14:49**。
公开站点：[openpoker.zve.ccwu.cc](https://openpoker.zve.ccwu.cc)。

## 版本与配置

- 应用版本：`2.0.3`；[源码提交](https://github.com/hewenyu/jev-card-agent/commit/00940eb05ca2e801f91d7b22c35aec76b27c222b)：`00940eb05ca2e801f91d7b22c35aec76b27c222b`。
- [镜像发布流程](https://github.com/hewenyu/jev-card-agent/actions/runs/36205927494)成功，已核对 `linux/amd64`、`linux/arm64` 的源码 revision。
- 实际部署镜像：`hewenyulucky/jev-card-agent@sha256:82d15dfd728a66901d336b28b4d39a5c2a03654d02b3a2314888fba9b84e0e2e`。
- DuelLoop SDK 保持正式版本 `v0.2.2`，原有数据挂载、容器用户、actor/scope 和评价协议保持不变。

容器内实际配置已核对：

```dotenv
DUELLOOP_RESEARCH_ENABLED=true
DUELLOOP_RESEARCH_BASE_URL=https://api.apikey.fan
DUELLOOP_RESEARCH_MODEL=deepseek-flash
DUELLOOP_RESEARCH_THINKING=enabled
DUELLOOP_RESEARCH_EFFORT=high
DUELLOOP_ACTIVATION_MODE=automatic_after_validation
```

研究密钥已替换为本次提供的新密钥，只有私有配置保存其值。通过摘要比对确认容器
加载了预期凭据，原有 Jev、OpenPoker 和管理凭据未变。部署配置移除了 13 个旧模型
变量；容器中不再存在 `REASONING_*`、`DEEPSEEK_*`、旧异步研究变量或
`HYBRID_TIMEOUT_MS`。实时动作继续由 Jev 决定，研究模型不直接操作牌桌。

此次先明确更新 `.env`，再通过 Compose 更新镜像。`manage.sh update` 不执行
环境变量迁移；`migrate:duelloop` 是独立的副本迁移流程。

## 备份与恢复

研究调度先暂停，当前手完成并由官方确认离桌后，容器于 **01:02:52** 停止。
停止全部应用写入后，流式归档五个数据库、存在的 WAL、两个评价协议及原部署配置。
归档含 23 个文件，源文件合计 **19,022,118,217 bytes**，压缩后
**2,700,606,641 bytes**。SHA-256：

```text
09a7bfa2b0313fac7582d3e0a893da1e659adf605668204f5040c80da309b15d
```

服务器完成了归档 SHA-256、gzip CRC、每个成员的 SHA-256 和大小验证；之后再次
完整复验。没有创建未压缩数据库副本，也没有清空历史。新归档仅确认服务器副本，
不声称另有已验证的本地副本。

按既有规则保留最近三个完整批次：本次上线前、v2.0.2 上线前以及 2026-09-25 的
旧生产停机归档。重新核验文件身份、摘要和容器挂载后，删除唯一最老的 v1.4.3 前
归档，释放 **816,696,045 bytes**；保留清单及原清单副本均在私有目录中。

配置替换后，新运行于 **01:09:59.736** 启动，研究调度恢复启用。

## 实际验收

- 本地完整验证：919 项单元/集成测试、65 项浏览器测试、lint、typecheck、构建和仓库检查通过；GitHub 的完整检查与镜像发布均成功。
- 本地真实 provider 探针：两次 HTTP 200，合成只读工具调用、nonce 回传和 thinking 正常，耗时 2,534 ms。
- 服务器使用实际新配置的独立探针：两次 HTTP 200，返回模型身份 `deepseek-flash`，合成工具调用及续接、thinking 正常；耗时 1,598 ms，用量为 979 input / 101 output tokens。费用未知，不将其记为免费。
- 公网健康、首页、dashboard、framework 均返回 200；匿名 `canControl=false`，写请求返回 403。
- 验收采样时，新运行有 **14 次被接受的 Jev 动作、6 手核实结算**；Bot 正常 playing，无持久停牌、重复接受回合、同手 release/facts 混用、过期不确定发送或未决 SDK intent。
- 账户与官方积分核对通过。结算反馈持续投递：01:14:27 曾观察到待投递队列清零；01:14:49 的新结算另有一条待投递反馈，尝试次数为零，无延迟绑定积压。该采样不等于队列持续为零。

本次探针是隔离连通性验证，不是生产策略研究结果。验收窗口内尚无新生产研究请求
完成，研究调度处于启用且 idle 状态；原有历史研究失败记录继续保留。实际使用的
策略仍来自 bootstrap，没有新的独立验证策略被启用。本次部署不证明策略改善或盈利。
