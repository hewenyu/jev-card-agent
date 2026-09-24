# Connection status and decision validity / 连接状态与决策有效性

## Incident / 故障依据

In 1.4.1, an opponent changing from `active` to `disconnected` while Jev was answering changed the decision fingerprint. The turn authority, cards, prices, chips and participation were unchanged, and Jev returned successfully in 443 ms. The runtime nevertheless recorded `decision_state_changed` and persisted a stop after the hand. A replay of the recorded events reproduced the fingerprint mismatch. The public projection also removed the reason by always returning `error: null`.

1.4.1 中，对手在 Jev 请求期间从 `active` 变为 `disconnected` 会改变决策指纹。该回合授权、牌面、价格、筹码与参与资格均未变化，Jev 在 443 ms 内成功返回，但运行时仍以 `decision_state_changed` 记录失败并在本手结束后持久停牌。原事件重放已复现指纹差异。公开投影又固定返回 `error: null`，导致页面无法解释停牌。

## Fix contract / 修复合同

- Treat `active` and `disconnected` as equivalent only for connection status in the submission fingerprint. Preserve the observed status in the current state, frozen decision context and recorded history. A disconnected player remains in the hand until authoritative participation or action evidence says otherwise.
- Retain all checks for table, hand, turn token, actor, cards, prices, stacks, bets, participation, folds and other material seat states. Unknown statuses must not become equivalent by accident. Jev remains the only live action selector; no local substitute or automatic clearing of all failure blocks is introduced.
- Publish fixed, sanitized stop/failure messages. Never echo arbitrary exception text, credentials or provider response bodies. The anonymous website remains read-only and cannot resume the Bot.
- Verify the recorded `your_turn → table_state` sequence with a controlled pending Jev call, both disconnect and reconnect, and negative cases with changed decision facts. Verify public error sanitization and visible UI behavior.

- 仅在提交指纹的连接状态比较中，将 `active` 与 `disconnected` 视为等价；当前状态、冻结决策上下文和历史仍保留真实状态。对手断线不等于退出当前手牌，以权威参与状态和行动记录为准。
- 保留牌桌、手牌、行动授权、当前行动者、牌面、价格、筹码、下注、参与资格、弃牌及其他实质状态的校验；未知状态不能被统一忽略。正式动作仍只来自 Jev，不增加本地代打，也不无条件清除故障停牌。
- 公开固定的脱敏停止/故障说明，不回传任意异常原文、凭据或供应商响应体。匿名网站保持只读，不能恢复 Bot。
- 用受控的待返回 Jev 请求验证真实的 `your_turn → table_state` 顺序，覆盖断线、重连及真正局面改变的反例；验证公开错误脱敏和页面展示。

## Release / 上线

Run repository checks and browser tests, publish the image through the existing no-cache GitHub workflow, then update production manually with Docker Compose. Confirm the Bot has finished its hand and left the official table; back up persistent databases and preserve all history. After verifying the deployed revision, explicitly resume the existing failure block through the private management script and confirm a new Jev action is accepted. Keep asynchronous DeepSeek research configuration unchanged.

完成仓库检查与浏览器测试，通过既有 GitHub 无缓存流程发布镜像，再手动使用 Docker Compose 更新。先确认当前手结束及官方离桌、备份持久数据库并保留全部历史；核对部署版本后，通过私有管理脚本显式恢复本次故障停牌，并确认新 Jev 动作被官方接受。异步 DeepSeek 研究配置沿用现有设置。

## Validation / 验证结果

`npm run check` passed: lint, formatting, TypeScript, 592 unit/integration tests, production build and repository checks (including the 1,000-line limit and configured-secret scan). `npm run test:e2e` passed all 64 browser tests.

The added runtime tests cover disconnect/reconnect while Jev is pending, one successful Jev call and accepted action, preservation of observed status, and rejection of changed stacks, bets, participation, folds, unknown/other statuses, pot and legal actions. Public API tests cover persisted stops, fixed error messages, unknown-error redaction and rejected anonymous control requests. Browser checks cover Overview/Live notices while unseated and clearing the notice on recovery.

A private replay of the incident's recorded events confirms identical action authority and decision fingerprints after this fix while the observed opponent status still changes from `active` to `disconnected`. No real model call is needed for that regression check. Production deployment and action acceptance are separate operational checks performed after image publication.

`npm run check` 已通过：lint、格式、TypeScript、592 项单元/集成测试、生产构建及仓库检查（含每文件不超过 1,000 行和已配置密钥扫描）。`npm run test:e2e` 的 64 项浏览器测试全部通过。

新增运行时测试覆盖 Jev 待返回期间的断线/重连、仅一次 Jev 调用并成功接受动作、保留原始状态，以及筹码、下注、参与、弃牌、未知/其他状态、底池和合法动作真实变化时仍拒绝旧决策。公开 API 测试覆盖持久停牌、固定错误说明、未知异常脱敏及匿名控制请求被拒绝；浏览器测试覆盖离桌后 Overview/Live 提示和恢复后清除。

私有原始事件重放确认，修复后行动授权和决策指纹保持一致，对手原始状态仍从 `active` 变为 `disconnected`；该回归验证没有调用真实模型。生产部署与实际动作接受在镜像发布后单独验收。
