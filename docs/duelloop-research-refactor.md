# DuelLoop strategy research lifecycle

Implementation baseline: application 1.4.3 (`96db765`), after PR #6. This document
precedes the research implementation. The downloaded proposal was written against
an earlier pre-merge commit; the production roster-order fix remains intact.

## Ownership and isolation

`ResearchOrchestrator` and `ResearchWorker` own research creation, frozen evidence,
validation, cancellation, recovery and release registration. The application only
assembles them, supplies a real DeepSeek Messages provider, independent poker
evaluator and explicit controls. No legacy queue, advice publisher or second
research state machine is used.

A separate worker thread receives an explicit configuration allowlist and an empty
environment. It can read the framework store and call DeepSeek and Jev for research
and evaluation. It receives no OpenPoker token, WebSocket client, submit action
callback or public control credential. CPU-heavy evaluation cannot block the live
event loop. The application continues to use a single live deployment.

## Provider and resources

DeepSeek uses its native Anthropic-compatible Messages endpoint, exact model
`deepseek-flash`, and explicit thinking configuration. Framework tools are the only
allowed actions. Tool responses remain data; untrusted evidence cannot add tools.
Each request observes the original cancellation signal and a bounded timeout,
with at most three retries, safe Retry-After handling and usage accounting.
Single mode reuses one provider session for researcher/adversary/integrator roles;
the SDK releases it after the run. Unknown token usage stays unknown; it is not zero.

There is no monetary budget gate. Token/call/time bounds limit runaway operations
and SDK resource consumption, not willingness to pay. Limits and holdout exhaustion
are visible in status. Interrupted remote requests are not replayed automatically.

## Publication and recovery

Newly settled trajectories trigger research; corrections to the same hand update
evidence but do not count as new independent hands. The worker explicitly selects
the SDK `first_settlement` trigger mode. Startup invokes SDK recovery before new
work; completed validation can finish release registration without repeating models.
Created, never-started runs may resume; interrupted paid work becomes an explained
error according to the SDK contract.

Development and final evaluation protocols are separate immutable inputs with
disjoint seed blocks and holdouts. An injected independent evaluator is mandatory.
No evaluator or no final validation means no research release. Statistical
inconclusive results do not establish profitability.

Activation defaults to `automatic_after_validation`. Research only registers pending
releases; the live host consumes eligible validated releases before pinning a new
hand. `DUELLOOP_ACTIVATION_MODE` can select `explicit` or `candidate_only`.
Authenticated host controls approve/activate a specific release or roll back using
the live SDK runtime, preserving its boundary and compatibility checks. Research
pause, run cancellation, activation pause and bot stop are distinct operations.
Future hands consume new releases; an already pinned hand retains its release.

## Verification contract

Tests cover Messages tool execution and usage/cache accounting, identity mismatch,
bounded retry/cancellation, allowlisted worker credentials, SDK recovery, trigger
configuration and release delegation. Integration tests inject fixture providers
and evaluators; real model checks are separately identified. This implementation
does not claim a demonstrated increase in live profit from passing engineering
tests.

### Verified integration evidence (2026-09-24)

An isolated real `deepseek-flash` Messages probe completed one allowlisted,
read-only fixture tool and returned `no_change`: two HTTP requests, 1,494 ms,
893 input tokens (including cache categories) and 34 output tokens. Thinking was
disabled. This checked the wire protocol and tool continuation only, not poker
quality. No arena connection or strategy activation was involved. The endpoint
did not report a complete dollar amount, so cost remains unknown. Private raw
request events are in the ignored local review directory; credentials are absent
from the public report.

The worker lifecycle test starts the actual isolated worker, verifies idle
operation without remote calls, pauses it, restarts it and verifies the durable
pause before resuming. Development uses an ESM-aware TypeScript import; production
starts the compiled JavaScript directly without a development dependency.

Public status is an explicit read projection of release identifiers, bounded
recent run counters and lifecycle state. SDK run data, prompts, provider
configuration and private artifacts are excluded. Score details distinguish
provider confidence from argmax selection probabilities and preserve incomplete
usage as unknown. The Live page refreshes this projection; archived Choice and
legacy advice records retain their existing read views.

## 中文说明

慢循环仅使用 DuelLoop 的研究状态机和持久化记录。DeepSeek 调用受控研究工具，
Jev 负责独立评价中的真实决策；独立 worker 没有牌桌执行凭据。默认人工明确
激活验证合格的 pending release，取消研究、暂停研究、暂停发布和停止 bot
相互独立。首结算触发避免把旧手修订算成新样本。金额不设门槛，时间、调用和
token 限制用于阻止失控任务。未知用量不当作零，进程恢复不自动重放已经发生
的付费请求。策略统计不显著时保持原策略，工程验证通过不等于证明线上盈利。
