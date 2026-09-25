# Thinking research and automatic validated strategy activation

Requested behavior: DeepSeek research uses thinking with `high` effort. A research
strategy that passes the independent final evaluation becomes eligible for
automatic activation; Jev uses it at the next unbound hand. Research remains
asynchronous and never executes Arena actions.

## Implementation contract

- Default `DUELLOOP_RESEARCH_THINKING=enabled` and
  `DUELLOOP_RESEARCH_EFFORT=high`. Preserve the Messages thinking blocks across
  tool rounds and audit the actual requested thinking settings without exposing
  credentials, signatures or private prompts.
- Add `DUELLOOP_ACTIVATION_MODE=automatic_after_validation`, with `explicit` and
  `candidate_only` available for controlled/offline operation. All production
  components use the same configured mode; a worker restart must not silently
  force explicit approval again. Activation pause remains independent.
- Before the live host creates a new hand binding, ask the SDK to activate an
  eligible pending release. This operation reads already completed validation;
  it never waits for research or calls another model.
- Existing complete or partially persisted hand bindings retain their original
  release and facts. Reconnect/restart must not change a bound hand. New hands
  read the newly activated release, and their recorded Jev questions and release
  digest provide evidence that the strategy was consumed.
- Keep SDK validation, behavior dependency checks, expected-base conflict checks,
  unknown execution blockers and activation pause. Failed or inconclusive
  research, bootstrap releases and invalid/stale candidates cannot bypass them.
- Keep research trigger/cooldown and all raw history unchanged. Synthetic passed
  validation can test the wiring in isolation; never register it in production or
  present it as real strategy improvement.
- Persist settlements atomically with raw hand records even if asynchronous hand
  binding has not completed. Reconcile only against the original complete host
  facts and matching SDK release; never create a historical binding from current
  knowledge. Preserve settlement corrections and count the first settlement once.
- Check the runtime lease when a queued binding starts and again after automatic
  activation, before writing the hand binding.

## Verification and rollout

Test enabled/high provider requests including a thinking/tool continuation; test
passing/rejected/stale/paused candidates and same-hand/restart boundaries with the
real SDK in isolated stores. Run the repository checks and browser regressions.
Verify the real DeepSeek provider with enabled thinking using existing private
credentials, without connecting another Bot.

Build and publish through the existing no-cache GitHub workflow. Drain the current
production hand and confirm official departure before the manual Compose update.
Preserve the SDK database, scope, hand bindings and pending intents. Verify the
deployed model settings, activation mode, accepted Jev actions and research status.
Record actual research/activation evidence separately from isolated test evidence;
do not claim a new strategy passed before it has done so.

中文：DeepSeek 慢循环开启思考，强度默认 high。只有独立最终评价通过的策略才可
自动激活；宿主在尚未绑定的新手开始前消费 SDK 待激活版本，同手及重连继续使用
原固定版本。研究失败、评价不确定、策略基线已变化或激活暂停时，继续使用现有
策略。上线必须等待当前手完成，保留历史与运行身份；真实验证结果与隔离回归
证据分别记录。

## Verified before deployment (2026-09-25)

An isolated request through the actual DeepSeek provider used `deepseek-flash`,
`thinking=enabled`, and `effort=high`. It completed one read-only tool round over
two HTTP requests in 1,312 ms, with returned thinking blocks and preservation of
those blocks in the continuation. Recorded usage was 946 input and 57 output
tokens. This verifies configuration and tool continuation, not poker research
quality or a production strategy update. No Arena connection was created.

The SDK integration regression verifies a validated fixture release changes the
actual Jev questions for a new hand, while existing hands, restart recovery and
partial bindings retain their original release. Rejected/inconclusive validation,
stale baselines, activation pause, explicit/candidate-only modes and unresolved
execution prevent automatic adoption. All fixture validation stays isolated.
