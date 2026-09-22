# 1.4.0 verification / 验证记录

This release addresses low research frequency, opponent memory lost across tables, and validated model guidance being replaced by a generic template. The [implementation contract](research-iteration-1.4.md) preceded code changes. The [operations guide](async-llm.md) describes configuration, independent approval and safe Compose deployment.

本版针对研究频率、跨桌记忆和策略原文采用进行改进。统计/发布/采用是不同指标；模型策略通过结构与证据校验，不代表已经证明盈利。

## Verified behaviors

- Independent per-opponent completed-hand windows, cutoff enforcement, read-only raw access and rebuildable derived index.
- Significant settled events reference their actual server action and decision when attribution is unambiguous. Late events update evidence availability; decision-visible information remains separate from later showdowns.
- Initial/refresh/global thresholds, event deduplication, bounded priority and fair pending replacement. Pending trigger evidence cannot silently disappear; adding decision attribution does not re-charge the same event.
- Separately approved model guidance retains its original text through publication and the actual Jev HTTP request. Legacy templates, publication hashes and hand pins remain compatible.
- Guidance checks reject unsupported scope, numbers, hidden-card certainty, unconditional action commands, missing limitations and oversize cards. Small samples expire sooner. Global free-text changes remain manual proposals.
- Current-run versus all-history calls, retries, insufficient results and actual adoption have explicit denominators. Public views refresh without mutation requests and fit a 390-pixel viewport.

## Executed checks

`npm run check` passed: lint, formatting, TypeScript, 555 unit/integration tests, production build and repository validation. The longest maintained file is 991 lines, below the 1,000-line limit; no configured secrets were found. `npm run test:e2e` passed all 59 browser tests, including research progress/current-run counters, asynchronous refresh, approved limitations, anonymous read-only access and mobile layout. The 390-pixel research screenshot was visually inspected.

已执行完整检查与 59 项浏览器测试；手机端新增研究信息可读，没有横向溢出，公开页面没有发送管理写请求。

## Production data inspection

A read-only aggregate of the latest 5,000 production `player_action` events found `contribution_delta`, street and timestamp on every event. Of these, 837 matched this bot's stored action IDs and four confirmed investments reached at least 20 BB. This verifies that the event trigger can use actual server amounts rather than a proposed candidate's amount. This sample contained no action received after its hand result; that failure condition is covered by a constructed regression.

最近 5,000 条线上事件全部带有真实新增投入字段，其中 837 条匹配本 Bot 的动作 ID，四次达到至少 20 BB。晚到事件的行为通过专门回归验证，不能将其称为线上已观测案例。

## Real isolated DeepSeek checks

The final `deepseek-flash` Messages probes used thinking disabled and frozen production evidence in a separate ledger, without connecting a second Arena client:

| Final opponent task | Attempts | Total duration | Result                                                                                      |
| ------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------- |
| Opponent A          | 1        | 2,537 ms       | Valid guidance published locally                                                            |
| Opponent B          | 2        | 4,031 ms       | Invalid evidence reference rejected; first retry succeeded with trusted validation feedback |

The published cards contain 228 and 222 characters. Their original hypothesis, guidance and limitations survived into captured Jev HTTP request bodies using the real opponent-name mapping; this consumption check used a local mock transport and made no paid Jev calls. A global review in the initial probe succeeded in 2,853 ms and remained a manual proposal.

Across development, seven logical tasks made 17 real HTTP attempts: four succeeded and 13 failed validation. This includes an intermediate overly strict per-field drafting limit that was removed. The original 300-character total limit remains enforced; the smaller field sizes are suggestions only. Failed attempts were retained, not relabelled successful. Only research opts into repair feedback; the frozen evidence is unchanged and no rejected model prose or arbitrary error text enters the retry instructions.

最终真实研究两项均成功，其中一项明确验证了“校验拒绝 → 带可信原因重试 → 原文发布”。整个开发过程的失败也完整保留；不能把最终两项成功包装为全部尝试均成功。本地 Jev 消费验证使用模拟传输，线上采用和 Arena ACK 仍需在实际部署后独立核对。

The frozen production archive contains 2,266 hands, 64,922 events and 3,066 decisions. New evidence preparation preserved the raw file hash, produced seven bounded batches and retained loss/win/zero comparisons. Two large investments previously displaced by recent showdowns now include their exact accepted decisions. The largest serialized research input was 46,058 characters, below the existing 48,000-character transport limit. Source identity values and credentials were checked against the sanitized batches and were not exposed. On the same server and frozen archive, a repeated evidence build decreased from 13.73 to 9.20 seconds after query changes; this is a single comparison, not a P95 latency measurement. It remains work in the independent research thread, and the configured scan delay is additional to tick preparation and inference time.

## Interpretation

Actual adoption means the saved Jev request contains the approved guidance. An Arena acknowledgement verifies that the resulting Jev action was accepted. Neither observation estimates the counterfactual value of an alternative action or establishes long-run profitability. Continue evaluating net chips, bb/100, drawdown and sufficient hand/session samples with stable experiment labels.

All exact diagnostic requests, source databases, operator notes and release backups remain private under ignored review directories or the server's persistent data volume. No keys are published. Deployment preserves completed history and finishes the current hand before container replacement.
