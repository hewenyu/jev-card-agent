# PR #6 audit response

The 2026-09-24 joint audit reviewed DuelLoop `4bd7e9b` / 0.2.0 and PR #6
`869e532`. This update addresses the findings within the existing shadow-experiment
scope; it does not claim a production dual-loop migration.

## Changes agreed before implementation

| Finding                                                                                      | Response and verification                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1–D4: research cancellation, publication recovery, revised candidates and session retention | Upgrade the pinned public SDK to 0.2.1 (`cba13bb`), inspect its fixes and run its local regression suite. These paths remain upstream capabilities, not newly activated poker research.                                                                                                                                                                 |
| D5: unknown cost reported as zero                                                            | Preserve SDK 0.2.1's independent token/cost completeness and known-cost subtotal through the application wrapper and report. Never turn partially known costs into a complete total.                                                                                                                                                                    |
| J1: immediate 429/5xx retries                                                                | Retain only a validated numeric Retry-After delay from HTTP headers; add abortable exponential backoff with jitter under the original shared signal. Keep the initial request plus at most three retries; waiting never renews the deadline or authorizes another call after cancellation. Distinguish transport failures from malformed model answers. |
| Log durability wording                                                                       | Flush attempt start, finish and late-result records before returning from the write boundary; exercise flush failure before model submission. State the operating-system flush boundary without claiming physical power-loss certification.                                                                                                             |
| Trusted history versus arbitrary imports                                                     | Explicitly label inputs as trusted production archives. Existing top-level and integrity checks do not independently authenticate nested knowledge/advice evidence cutoffs. Do not claim this accepts independently verified third-party archives.                                                                                                      |

The previous 24-call real-model report remains an immutable 0.2.0 experiment.
It must not be relabelled as new-SDK or new-backoff evidence. New local regression
results, source provenance and package integrity will be recorded separately.

## Acceptance

- The audit's 100 ms transient rate limit recovers inside its original 1 s window.
- A longer Retry-After, cancellation during sleep, expired deadline and failed
  ledger cannot initiate another request. Authentication and model identity
  failures remain terminal; malformed answers are not called network outages.
- Actual public SDK plus loopback HTTP tests verify Retry-After survives transport
  sanitization without retaining response bodies, credentials or arbitrary headers.
- Known token counts with missing dollar cost remain explicitly cost-unknown;
  partial costs retain a labelled subtotal, never a fabricated full total.
- The new vendored package reproduces from its public commit, clean installs
  work, repository checks and browser regressions pass, and PR #6 is updated.

## Executed evidence

The public annotated tag `v0.2.1` resolves to
`cba13bb69453f7ea2cd7a79db9d3fbe9859eabc4`. Its full local SDK suite passed
**221 tests, zero failures/skips**. The inspected regressions cover:

- D1: two SQLite connections cancel a Pi request; no second request is sent,
  including JSON repair, and already incurred token usage remains recorded.
- D2: five publication transaction failure points, database reopening and four
  process-exit boundaries; recovery registers locally without rerunning models
  or consuming the holdout again.
- D3: `revise` removes final eligibility; unresolved analysis does not publish,
  whereas a resubmitted candidate can proceed.
- D4: eight completed local Pi research runs release their sessions while role
  outputs remain stored; in-flight release waits for late usage.
- D5: token-only, partially billed, explicitly free, malformed and overflowed
  usage keeps token and dollar completeness separate.

The package is 165,230 bytes with SHA-256
`4a38c6bec56864a792b5e1279fa464f382c26f9342e870aa4fa785ac86d83adb`.
`node scripts/verify-duelloop-package.mjs` reproduced it byte-for-byte from the
public commit. Separate clean temporary installs verified both SDK availability
with `npm ci` and its absence with `npm ci --omit=dev`; Fastify still responded 200
in the latter environment.

The application's actual SDK/HTTP regression and a separately recorded local probe
exercise J1 without paid model calls or an Arena connection:

| Scenario                                       | Observed result                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| 100 ms rate limit, 1,000 ms original deadline  | Two requests at 20.11 / 141.47 ms; succeeded at 145.78 ms, original signal unexpired |
| 2,000 ms Retry-After, 150 ms original deadline | Exactly one request; cancelled at 153.91 ms; no premature retry                      |

Timing is local test evidence, not a real-provider latency claim. The successful
probe's aggregate token usage remains incomplete because its first 429 reported
no usage; its dollars remain unknown. See [probe output](verification/duelloop-audit.json).

Only numeric Retry-After duration, HTTP status and a fixed failure category survive
transport sanitization. Tests also cover HTTP dates, invalid headers, concurrent
request isolation, redirects, body-stream interruption, cancellation during wait,
very large waits, terminal authentication/identity errors and synchronous flush
failure before any model submission.

A further deadline boundary found while reviewing the fix is covered as well:
a synchronous start-log flush can delay AbortSignal's timer callback. The runner
also supplies the fixed absolute SDK model deadline (including its 25 ms reserve).
The wrapper checks that wall clock before submission and after the flush; a late
flush leaves a start intent but makes no provider call. Waiting never recomputes
or extends that absolute deadline.

Final application validation passed **729 unit/integration tests across 84 files**
with `npm run check`, including lint, formatting, TypeScript, production build,
file-length and configured-secret checks. All **64 Playwright browser tests**
passed. The longest checked source file remains 991 lines, below the 1,000-line
limit. These are local test results; the separate SDK suite contains 221 tests.

The SDK's source and local regressions have been checked; that is not a claim of
long-running production research qualification or profitable 6-max play. No
production deployment or new paid-model benchmark was performed in this update.
