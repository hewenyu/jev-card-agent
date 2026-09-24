# v2 audit corrections

Baseline: application `20222b827c2e69599db9bb3f8d41d4b44d8e5988`, SDK
`422e24832919a3d72a2936272365e4c827178ec2`. This work updates application PR #7
without merging or deploying the application. The SDK was subsequently merged
and tagged under the separate release authorization below. Findings were reproduced locally
with synthetic models and local WebSocket services before implementation.

## R1: recover an interrupted, unsubmitted decision

A cancelled SDK record is audit evidence, not a reusable action. Permit a new
Score decision only after confirmed caller cancellation without an execution
intent, under the same valid authority/state and host lease. Preserve the original
hand facts/session and the earliest effective model and authority deadlines.
Successful stored decisions remain reusable; unresolved intents recover their
original command. Other model failures, identity errors and unknown execution
remain blocking failures.

Each decision attempt needs a durable identity separate from its turn revision.
Provider calls and late usage must remain attached to that attempt, including
after restart. A cancelled attempt must not inherit calls from its replacement.
The provider's initial request plus at most three retries remains unchanged.

If the process dies or storage fails after a durable attempt starts but before
the SDK records its outcome, the unresolved attempt still requires reconciliation. Automatic recovery
is limited to confirmed cancellation; it does not infer success or repeat unknown
work. A recovered intent keeps the run identity of its actual decision attempt.

Acceptance includes a real local WebSocket disconnect during Score, same-turn
reconnection, a single submitted replacement action, unchanged deadlines, no
persistent cancellation block, and no execution of a late old answer. Preserve
existing unknown-intent and genuine-model-failure regressions.

## R2: share live and evaluator session semantics

Construct behavioral poker context through one shared helper. Each independent
evaluation branch maintains its own per-hand history and appends an accepted Jev
choice only after the environment applies it. The first request contains turn 1
and an empty history; later requests contain only earlier decisions. Keep existing
live historical statuses and failed/cancelled evidence semantics explicit.

Version the feature/continuation and evaluator contracts. Existing reports remain
historical artifacts; they cannot be reused as validation of the corrected input.
SDK dependency checks also reject old active releases; copy migration does not
convert their approvals. See the [migration compatibility boundary](duelloop-migration.md).
Verify first turn, same-street continuation, street changes, repeated raises,
branch isolation and session-sensitive behavior equivalence. No poker rule or
opponent-suite behavior change is intended.

## O1: make the Compose migration handoff executable

Generate or document an explicit Compose configuration for migrated working
copies, mapping every database and private protocol into persistent container
paths. Do not silently combine an old raw volume with new derived databases.
Keep original files and snapshots unchanged, retain unresolved blockers, and
disable bot/research autostart until the operator enables the reviewed release.

Validate the actual production image against a complete synthetic five-database
migration, including committed WAL data, historical reads, protocol access,
restart persistence and restoration from preserved originals. Do not connect to
the Arena or inject real model keys during these checks.

## Scope and verification

Monetary admission gates remain intentionally excluded at the user's request.
Request/usage audit and bounded research task execution remain in scope. Run the
affected regressions, complete repository checks, browser tests and applicable
Compose restore checks; record actual results below before updating PR #7.

## Verification on 2026-09-24

- `npm run check` passed: lint, formatting, TypeScript, 873 tests across 107 files,
  production build and repository checks. All 424 inspected files satisfy the
  1000-line limit (maximum 996); no configured secrets were detected.
- `npm run test:e2e` passed: 65 browser tests in 24 seconds.
- R1 regressions cover an actual local WebSocket disconnect, same-turn retry,
  late usage without execution, cold cancellation recovery, original SDK model
  deadline expiry, real model failure after the initial call plus three retries,
  intent restoration with the replacement attempt's run identity, and storage
  failures during cancellation that must remain unresolved across restart.
- R2 regressions cover first/same-street/next-street/repeated-raise projections,
  a session-sensitive model, separate concurrent branch histories, the real
  coordinator's durable session reader and rejection of old evaluation dependencies.
- Five migration regressions passed, including committed WAL across all five
  stores, private protocol copies and actual Compose environment parsing.

- A final `docker compose build --no-cache --pull` and complete production-image
  migration/restore drill passed. Image ID:
  `sha256:e557b653cbe0fd9d55526b51cede38a923f5846d8a45c86243233d9f49287bea`
  (`linux/arm64`). The compiled coordinator matched the local build. HTTP history,
  protocols, blockers, all five stores after recreation, and restored backup
  copies were verified; source/backup bytes stayed unchanged. Temporary test
  containers, networks and data were removed.
  The container's installed package metadata identifies the official `v0.2.2`
  release URL and expected integrity, with no `/app/vendor` fallback.

No real Arena session, paid model call or production change was made for these
corrections. Restoration used the current image; compatibility with the operator's
chosen previous-release image remains a deployment check.

## SDK release handoff

The user additionally authorized merging the SDK PR and tagging its official
distribution. [SDK PR #1](https://github.com/hewenyu/DuelLoop/pull/1) is merged;
annotated tag `v0.2.2` points to `7b518d21406b52c8dbc83a34031ee6f626237b4b`,
whose tree exactly matches the reviewed `422e248` source. Its
[GitHub Release](https://github.com/hewenyu/DuelLoop/releases/tag/v0.2.2) publishes
the `.tgz` and SHA-256 checksum. Fresh tag build, public asset download and retained
reference archive match byte-for-byte. Master CI `36012181066` and tag CI
`36012240122` passed. There are no remaining open SDK PRs.

The application uses the fixed release-asset URL with lockfile integrity; Docker
and the clean production installation check no longer copy a vendor fallback.
The archive in `vendor/` remains a reproduction reference. This is a GitHub
Release distribution; no npm registry package was published. Application rollout
remains separate from the SDK release.

`node scripts/verify-duelloop-package.mjs` passed against the public tag and asset.
`node scripts/verify-production-install.mjs --install-only` passed from a fresh
directory containing only the two package manifests: 310 production packages,
zero reported vulnerabilities, and successful SDK import. Only the SDK source
URLs changed in the lockfile; all package integrity and transitive dependencies
remained identical.
