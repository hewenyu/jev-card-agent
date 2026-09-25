# v2.0.2 deployment acceptance / 部署验收

Production observations below were captured on **2026-09-25 at 02:23:19 UTC**.
The public site is [openpoker.zve.ccwu.cc](https://openpoker.zve.ccwu.cc).

## Release and deployment

- [PR #9](https://github.com/hewenyu/jev-card-agent/pull/9), [release v2.0.2](https://github.com/hewenyu/jev-card-agent/releases/tag/v2.0.2).
- Source: `b1389cab779269d137d355baa94500d36cbe9609`.
- Official DuelLoop SDK: `v0.2.2`; unchanged released package.
- [GitHub publishing run](https://github.com/hewenyu/jev-card-agent/actions/runs/36084705206) passed checks and built `linux/amd64` and `linux/arm64` with `no-cache: true` and `pull: true`.
- Deployed image: `hewenyulucky/jev-card-agent@sha256:2d5b2943b060f6f606d9df0f387541f3a7174ab9bc9456fb6b490302717fa222`.
- The prior hand finished and the official API confirmed departure before Compose stopped the old container. A complete stopped-source archive preserved all five databases, private evaluation protocols and deployment configuration. The archive passed gzip, member hash/size and full archive SHA256 verification.
- Production resumed at **02:19:48 UTC**, with the existing history, SDK scope and hand bindings intact. Research scheduling was resumed separately.
- Backup retention is **three versions**. The new archive passed a second full server verification before the oldest four backup files were removed, reclaiming 774,095,806 bytes. No active database or history was removed.

## Effective configuration and observed behavior

The deployed application configuration and durable SDK scope both confirmed:

```dotenv
DUELLOOP_RESEARCH_MODEL=deepseek-flash
DUELLOOP_RESEARCH_THINKING=enabled
DUELLOOP_RESEARCH_EFFORT=high
DUELLOOP_ACTIVATION_MODE=automatic_after_validation
```

The new run had **17 accepted Jev actions** and **9 verified settled hands** at
the observation time. Health, anonymous read-only access, current official score
agreement, unique release/facts per hand and execution identity checks passed.
There were no unresolved SDK intents, duplicate accepted turns, accepted local
fallback actions, undelivered outbox entries or deferred settlements.

Jev remains the live action selector. Research is asynchronous. Only independently
validated eligible releases can activate before a new unbound hand; an existing
hand keeps its original release and facts. Activation still checks dependencies,
expected base, validation status, pause state and unresolved execution. Runtime
ownership is checked before and after queued activation.

Settlements arriving before asynchronous hand binding are now durably retained
with the raw hand record. Delivery uses only the original matching host/SDK
binding, survives restart and preserves corrections without counting a hand twice.

## Thinking evidence and strategy-update limits

An isolated real DeepSeek provider probe used enabled thinking and high effort,
returned thinking blocks and preserved them through a read-only tool continuation.
Two HTTP requests completed in **1,312 ms**, with 946 input and 57 output tokens.
This verifies provider behavior, not poker strategy quality. Private thinking text,
signatures, credentials and protocol seeds are excluded from public evidence.

No new production research request had completed since this deployment at the
observation time. The configured trigger remained **100 new first settlements**
and a five-minute cooldown; 64 first settlements had accumulated since the prior
trigger. The enabled/high settings are confirmed in production, but a production
thinking response was **not yet observed** in this window.

The previous run, under disabled thinking, made 15 HTTP requests with recorded
usage of 990,392 input and 22,361 output tokens. It exhausted the existing research
resource limit before any candidate evaluation. Its complete usage remains in the
durable ledger. Request input grew from 8,086 to 120,027 tokens; available logs do
not identify which specific tool responses caused the growth.

**No new validated research strategy was active at this snapshot.** Accepted
production decisions still used the bootstrap release. Automatic next-hand
adoption and Jev question changes passed isolated SDK regression tests; those
fixtures were never registered in production. A future successful research run
must pass final validation and its release digest must appear in subsequent
accepted decisions before claiming actual adoption. Deployment does not establish
profitability or guarantee that a candidate will pass.

## Verification

- `npm run check`: lint, formatting, typecheck, **109 test files / 914 tests**, build and repository checks passed.
- `npm run test:e2e`: **65 browser tests** passed.
- Real SDK tests cover passed/rejected/inconclusive/stale/paused candidates, original hand bindings through restart, lease loss, and batched WebSocket resync settlement delivery.
- Both PR checks and the tag publishing workflow passed.

中文：本次已上线 `v2.0.2`，实际配置确认 DeepSeek 开启 thinking、强度 high，并在独立最终验证通过后，由宿主在下一手自动启用合格策略。Jev 继续独立负责实时出牌，同手策略和事实版本固定。上线前正常打完当前手、确认离桌并完整备份，历史没有清空。

验收时新运行已产生 17 次被服务端接受的 Jev 动作、9 手完整结算，积分同步、只读访问、绑定一致性及执行检查正常。此时累计新增结算为 64/100，尚未触发部署后的下一轮研究，也尚无新策略通过最终验证；不能把配置开启或隔离回归当作真实策略已经更新。旧研究的失败状态和完整调用用量继续保留，后续合格策略才会自动启用。
