# Host execution and hand binding recovery

Design recorded before implementation, 2026-09-24, application baseline v1.4.3.
This document covers the host adapter around DuelLoop 0.2.2; it does not grant
execution authority or establish live profitability.

The application must never send without the immutable SDK decision, SDK intent,
matching host command, current lease, current turn identity and original authority
deadline. A prior possibly-sent command blocks a new decision; retrying that exact
command remains governed by the existing runtime's resync/idempotency checks.

Fault tests exercise decision-to-host projection, projection before intent, intent
before ready command, possibly-sent before sent status, raw receipt/outbox before
SDK receipt, and SDK receipt before outbox confirmation. Receipt delivery is
independent from accumulated feedback: feedback backlog cannot hide a terminal
ack from the fast loop. Conflicting identities, table/hand/action mismatches and
terminal contradictions remain visible failures.

Hand facts are written before SDK pinning. Their row retains the active release
observed when those facts were first saved. Recovery can finish an incomplete pin
only if that original release is still active, or if the SDK already has that exact
pin. A missing SDK pin cannot silently bind an old hand to a newly published
release. An SDK pin without its original raw facts cannot be reconstructed from
new statistics. Invalid timestamps, future publication/evidence and digest tampering
are rejected. Cached hand data are returned by value.

The tests use fixture Score responses and local SQLite databases. Six execution
windows and separate facts/pin windows are tested at their durable boundaries;
actual network authority/reconnect behavior remains covered by runtime integration
tests. No real bot or paid provider is started by these tests.

Verification: `tests/duelloop-host-bridge.test.ts` (13 cases),
`tests/duelloop-hand-bindings.test.ts` (9 cases),
`tests/duelloop-live-runtime.test.ts` (6 cases) and the coordinator's 7 cases
passed together (35 tests) against SDK commit
`9f501b32bf0f4a8d30d3102bde37869fb772fd4e`. The WebSocket fixture uses the actual PokerRuntime and
LiveDecisionCoordinator. It verifies exact SDK action IDs and raise-to amounts,
completed receipts across consecutive hands, persisted model failure, same-key
reconnect without another Score request, and obsolete-authority cancellation with
a late response. The latter exposed and now guards task cleanup interfering with
the next task and cancellation incorrectly persisting a failure block.

Two cold-restart WebSocket cases close and reopen both databases: one starts with a
possibly-sent host command, the other stops after SDK intent but before host-ready
projection. Both recover the original payload and idempotency key without another
Score call, retain the original authority deadline, reclaim a new SDK owner token,
and finish with a completed receipt. The recovery API rejects an unresolved live
owner or an owner on another hostname whose death cannot be established. An
unclean Docker replacement with a different hostname therefore needs explicit
operational reconciliation rather than automatic ownership takeover.

Targeted ESLint and `git diff --check` passed. The SDK separately covers a real
child-process SIGKILL in its owner-recovery tests; the application WebSocket cases
exercise clean close/reopen and the two durable projection windows.
