# 1.3.0 asynchronous research verification

Development baseline: `12ab7a3508fff79893dd834e94cde686284f20fb` / 1.2.4. Target: 1.3.0 on `feat/jev-async-llm-research`. The accepted [v2 plan](async-llm-plan-v2.md) and [implementation contract](async-llm.md) were written before development. This section records pre-deployment development checks. Subsequent real provider calls and production activation are recorded in the [DeepSeek activation report](deepseek-live-activation.md).

## Evidence categories

- Engineering: controlled end-to-end proposal → validation → operator approval → publication → immutable next-hand pin → actual Jev adapter request → local WebSocket action ACK. Off/shadow request identity and live consumption are tested separately.
- Provider, at development sign-off: no new real supplier calls made for this iteration. Dedicated DeepSeek and configurable standard transports were exercised with controlled HTTP responses; real diagnostics require an explicit CLI invocation.
- Arena, at development sign-off: no new account connection, hand, live activation or production deployment performed. The public website still used the prior deployment at that point. No profitability result is claimed.

## Automated checks

Local `npm run check` passed: **500 Vitest tests in 65 files**, ESLint, formatting, strict TypeScript, production build and repository checks. The full Playwright suite passed **59 tests**. The longest maintained file remains 991 lines. Five configured secret values were checked against the repository and 188 build artifacts, with no matches.

Regressions cover evidence cutoff/late settlement, ambiguous seat attribution, proposal injection/ref rejection, approval/CAS/TTL/withdrawal, metric invalidation, queue coalescing/leasing, malformed output retries, unknown usage, worker restart isolation, immutable pin recovery, full request comparison and anonymous read-only observations. An initial full run exposed a brittle substring assertion that could match a random UUID; it was replaced with precise settlement assertions without removing the leakage checks, then the complete checks were rerun.

Request-archive tests use a second SQLite connection inside the controlled transport callback to confirm that exact JSON bodies and hashes are already durable before sending. Success, malformed output, HTTP failure and every retry remain readable after reopening the database; a failed archive write prevents network submission. Authentication headers are excluded. The research panel's 390px screenshot was also visually inspected for readable layout.

The [controlled vertical acceptance record](verification/async-llm-chain.json) starts with 12 completed synthetic hands and exercises the real EvidenceBuilder, research transport adapter, independent approval, publication, authoritative archive and Jev adapter. Its current hand stays unchanged; the next hand's actual request contains the approved guidance and matching lineage hash. There is one controlled research request and one Jev request per action. Local WebSocket submission/ACK and research-failure isolation are covered by separate runtime integration tests.

## Reproducible controlled performance

Tests generate private raw artifacts only when the output environment variables below are supplied. The exporter publishes only synthetic timing samples and environment metadata; the chain artifact contains a fixed whitelist of synthetic identifiers, hashes and assertions.

```sh
ASYNC_RESEARCH_PERFORMANCE_OUTPUT=data/reviews/async-llm-v2/isolation-performance.json npx vitest run tests/async-research-isolation.test.ts
ASYNC_ARCHIVE_PERFORMANCE_OUTPUT=data/reviews/async-llm-v2/archive-performance.json npx vitest run tests/knowledge-refresh-cache.test.ts
ASYNC_CHAIN_OUTPUT=data/reviews/async-llm-v2/chain.json npx vitest run tests/async-research-chain.test.ts
node scripts/export-research-verification.mjs
cp data/reviews/async-llm-v2/chain.json docs/verification/async-llm-chain.json
npx prettier --write docs/verification
```

Published artifacts:

- [Decision timing samples](verification/async-llm-timings.csv): 180 accepted local WebSocket actions, 30 per research scenario.
- [Unchanged archive refresh samples](verification/async-llm-archive.csv): 60 Controller refreshes.
- [Environment, percentiles and limitations](verification/async-llm-performance.json).

Scenarios: off, normal structured research response, network hang, rate limit, saturated queue and worker termination. The runtime uses the existing in-memory WebSocket test Store, the research worker reads an independent on-disk SQLite fixture, and Jev responses are controlled. These measurements establish non-waiting behavior under those conditions, not real provider speed or production hardware performance. Facts and state preparation share the existing `preparationMs` stage; knowledge time is included in it, not added twice.

The archive fixture contains 256 opponents and about 4.37 MB of deterministic statistics. It measures an initial changed archive separately from repeated unchanged Controller refreshes. Publication of changed large knowledge still has synchronous archive cost; this release does not claim zero overhead from knowledge or extra Jev prompt text.

On Apple M4 / Node.js 24.13.0, controlled preparation P95 was 0–1 ms and receipt-to-send P95 was 1 ms in each scenario. Initial changed archive creation took 33.667 ms; unchanged refresh P50/P95/P99 were 0.028/0.050/0.086 ms. Archive refresh uses fixed fixture service snapshots and excludes real source-database reads. These synthetic results are not a production latency comparison.

## Examples and replay

[Opponent brief](examples/opponent_brief.json) and [leak review](examples/leak_review.json) are validated controlled schema examples, clearly labelled as such. They are not represented as actual vendor output. Real diagnostics retain the frozen batch, response diagnostics, requested/actual model, each attempt, unknown usage and proposal ID privately.

The paired evaluation prepare command emits a labelled posthoc time-split manifest and complete planned A/C request hashes. Controlled tests run both through the Jev adapter and check complete actual requests, with no historical payoff assigned to alternatives. Evidence/support hands and timestamps are excluded from held-out decisions; development and holdout are disjoint. No paid 30-pair experiment has been run.

## Operations and preservation

Additive migrations preserve legacy full bindings and hashes. New hand references restore immutable combinations from the authoritative history database. Missing/corrupt archives or invalid pin timestamps fail closed and retain a durable stop. Worker restart and backup endpoints cannot resume poker. Compose backup captures raw/statistics/research databases with SQLite backup, including published evidence and usage. Production history was not modified or reset.

Live keeps its official Watch link and table first. Research status appears below, with off/shadow/live, pending approval, published/expired/withdrawn state, known/unpriced cost and actual request adoption. Replay shows the fixed advice, provenance and request hash. New anonymous browser tests cover refresh, 390px layout and absence of public mutation requests.
