# Turn-summary seat arrival / 行动摘要中的入座顺序

## Incident / 故障依据

Production 1.4.2 paused with `decision_state_changed` on 2026-09-24. Jev returned
in 367 ms. The current hand's authoritative snapshot showed an empty seat; the
next `your_turn.players` already listed a newly seated player without `in_hand`.
The following `table_state` marked that player `in_hand: false`, and only then
arrived `player_joined`. Replaying the recorded events preserves turn authority
but changes the decision fingerprint at the membership update.

线上 1.4.2 在 2026-09-24 因 `decision_state_changed` 停牌，Jev 耗时 367 ms。
本手权威快照原先显示空座位，随后 `your_turn.players` 提前出现新玩家，但没有
`in_hand` 字段；接着 `table_state` 明确该玩家不参与本手，最后才收到
`player_joined`。原始事件重放确认回合授权未变化，参与状态补全却改变了决策指纹。

The existing fix only recognized arrivals through `player_joined`. Consequently,
the frozen Jev context also counted this waiting player as an active opponent.
The fix must correct membership before context construction, not relax material
state validation after the model returns.

此前只处理 `player_joined` 先到的情况，导致等待者也进入了 Jev 的活跃对手上下文。
修复需要在构建上下文前识别参与资格，继续保留真实局面变化时的提交校验。

## Implementation contract / 实现合同

- Handle a new occupant first observed through the partial turn summary after an
  authoritative current-hand seat snapshot. Missing membership can be classified
  as waiting only with same-table, same-hand evidence; unknown initial/recovery
  state and a new hand must not inherit that inference.
- Preserve explicit server membership, existing players' chips/bets/folds and
  authoritative snapshot updates. Next-hand participation is refreshed normally.
- Verify the actual event order using controlled WebSocket tests, including one
  original Jev result accepted, correct opponent context, delayed join notice,
  next hand, and genuine price/stack/participation changes still rejected.
- Keep history, model retries and the no-local-action contract. Publish 1.4.3
  through GitHub's existing uncached workflow, manually update with Compose after
  official departure and backup, then explicitly resume this failure block.

- 覆盖本手权威座位快照之后，新玩家先出现在行动摘要的顺序；只有同桌、同手的可靠
  记录才能推断其等待下一手，初次恢复或新手不能沿用旧参与推断。
- 服务端显式参与字段优先，保留既有玩家的筹码、下注、弃牌及快照更新，下一手重新
  确认参与资格。
- 受控 WebSocket 测试验证原 Jev 结果被接受、活跃对手正确、迟到入座通知和下一手；
  价格、筹码或参与资格真正变化时仍拒绝过时结果。
- 保留所有历史及重试机制，不增加本地代打。通过 GitHub 无缓存构建发布 1.4.3，
  官方确认离桌并备份后手动 Compose 更新，再显式恢复此次故障停牌。

## Verification / 验证

The repaired reducer was replayed against the private production incident. The
turn summary, membership snapshot and delayed join now have identical turn
authority and decision fingerprints. The waiting seat stays `inHand: false`, and
the active-opponent count is two rather than three before Jev is called.

The targeted suite passed 81 tests. Full `npm run check` passed **749 tests in
85 files**, lint, formatting, TypeScript, build and repository checks; the longest
file is 991 lines. All **64 Playwright browser tests** passed. Tests cover first-turn uncertainty, new hands/tables, resync,
explicit participation, delayed joins, next-hand participation, and rejection
after a real stack, pot, call-price or membership change. Private production
events remain under ignored `data/`.

修复后重放原始线上事件，行动摘要、参与快照和迟到入座通知的回合授权、决策指纹均
保持一致。等待者持续为 `inHand: false`，调用 Jev 前的活跃对手数由错误的三人改为
两人。定向测试 81 项通过；完整 `npm run check` 的 **85 个文件、749 项测试**，以及
lint、格式、类型、构建、仓库检查均通过，最长文件 991 行；**64 项浏览器测试**全部通过。覆盖首次行动信息不足、
新手、换桌、恢复、显式参与、迟到入座、下一手参与，以及真实筹码、底池、价格或参与
变化时拒绝旧决策。原始线上事件保存在忽略的 `data/`。
