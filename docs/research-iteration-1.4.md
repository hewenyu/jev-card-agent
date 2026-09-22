# 1.4.0 research iteration / 研究迭代合同

Written before implementation, following the 2026-09-22 production review of 1.3.1. This document states intended behavior; executed checks and deployment observations are added separately after verification.

## Outcome / 目标

Jev continues choosing every live action. DeepSeek `deepseek-flash` (Messages, thinking disabled, initial attempt plus up to three retries) researches completed hands independently. This iteration makes research timely, lets validated scoped model guidance reach subsequent Jev requests, and explains research activity in the anonymous read-only UI. No bankroll/cumulative-cost stop is introduced. All existing history, immutable publications, hand pins and exact model requests are retained.

Jev 保持实时唯一动作来源，DeepSeek 独立研究已完成牌局。改进研究时效、具体策略建议的采用及前端可观察性；保留历史及每手固定知识，无资金预算门槛。

## Scheduling / 调度

- Defaults: first opponent brief after 10 eligible hands, refresh after 10 new eligible hands; global leak review after 25 new hands. Poll every 15 seconds, one model call in flight globally, bounded pending queue.
- Opponent windows are independent of the global latest 100-hand window. Select recently relevant opponents, retrieve their latest at most 100 verified completed hands across table changes, and preserve evidence/receipt cutoffs and ambiguous-seat exclusions. Historical indexing runs in the research worker/derived database, never on the action path.
- Large hero investment (at least 20 BB), a large settled swing (absolute result at least 30 BB), and a public showdown in a substantial pot (at least 20 BB) may trigger an early scoped/global review. Include the actual decision that caused a trigger, not just the final decision of that hand; later showdown stays separated from decision-visible information. Include ordinary/profitable/zero-result comparison examples. Loss alone is not an error label.
- Trigger events are deduplicated against frozen job evidence and coalesced per task/scope. Do not continuously rerun identical evidence. Prioritize salient completed events with fair aging; merging pending evidence must preserve original queue age. New research never interrupts an already running batch.
- Small-sample opponent briefs remain provisional. Unknown cards/ranges remain unknown. Failures keep the three request retries; job retry eligibility and insufficient-evidence waiting reasons are observable and bounded to prevent a busy loop.

默认同一对手首次 10 手研究，之后新增 10 手更新；全局新增 25 手复盘，15 秒扫描一次。大额投入、显著结算波动和重要摊牌可提前触发，但按已冻结证据去重。对手历史窗口独立维护，每个对手最多 100 个可信已完成样本；不把其他桌最近的 100 手当作唯一记忆。触发案例包含关键决策，结算后信息明确分离，保留正常及盈利对照。合并队列保留最早等待时间，避免后面的对手一直被替换而得不到研究。

## Guidance publication / 策略建议发布

Introduce a separately operator-approved guidance policy/recipe. Preserve the model's concise hypothesis, concrete suggested guidance and limitations when they pass independent code validation; do not silently replace them with a generic frequency sentence. Require verified metric/example references, current scope and rules, explicit sample limits, supported conditions and expiration. Reject hidden-card/bluff certainty, unsupported numerical claims, executable/control instructions, unconditional action commands and oversized content. Enforce the existing 300 characters per card / 900 total / 4096 bytes and at most three cards without dropping evidence to force a fit.

Validation establishes evidence lineage, applicability and contract compliance, not strategic optimality or profitability. New free-form global policy changes remain proposals for independent review. Operator approval covers the bounded opponent-guidance contract, not arbitrary self-approved model output. Old fixed-template approvals do not authorize it; legacy publications/pins are not rewritten. Each future hand reads only published eligible knowledge available at its admission boundary. Replays retain exactly the content that was actually sent to Jev.

新增单独审核的有限对手策略发布合同。通过证据引用、适用范围、样本限制、失效条件及内容校验后，保留模型的精简策略原文；不再全部替换成相同统计提示。校验不等于证明盈利。新的全局自由策略仍需独立审阅。现有字数/字节上限不变，旧审批和历史绑定不改写。

Distinguish current active-player count from original table/dealt roster in the model contract. A six-max table does not imply every advice item applies only while six players remain. Validate/surface narrow scopes; never silently broaden a proposal after publication.

## Public observation / 公开观察

Display all-history and current-run request attempts, failed attempts/retries, completed/insufficient jobs and actual advice adoption with explicit denominators. For each scope show evidence window, new/required hands, initial vs refresh stage, reason for waiting/trigger, last attempt and pending/executing state. A live worker is not the same as an active network request. Refresh asynchronously; expose no keys, raw private requests, controls or operator notes.

页面分开显示全历史与本次运行的请求/重试/证据不足/实际采用，展示每个研究对象的新增手数、门槛、等待或提前触发原因。公开端保持匿名只读，持续刷新，不发送管理请求。

## Verification and deployment / 验收与部署

Meaningful regressions cover per-opponent memory across unrelated tables, historical cutoffs, early event deduplication and inclusion of the triggering decision, fair queue coalescing, actual model guidance in the Jev HTTP body, rejection/invalidation, legacy archive preservation and public refresh/denominators. Run repository-required checks and browser suite; every maintained file stays under 1000 lines. Update English/Chinese READMEs and operational docs.

Use GitHub's no-cache multi-architecture build, manually pull/recreate with Docker Compose after completing the current hand and confirming unseated status. Back up all three databases, compare existing immutable history, approve the new contract privately, then enable research. Verify real DeepSeek requests, published model text and actual future Jev consumption separately. Do not claim a profitable strategy from a short deployment sample.
