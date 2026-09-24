# Deterministic facts service

The production `FactsService` replaces the old statistics worker's mixed knowledge publication. It reads raw history through a read-only SQLite connection and writes a separate derived facts database. It materializes completed public opponent encounters, immutable cutoff-bound snapshots and asynchronous mathematical audits. It does not import strategy cards, publish advice, or create a DuelLoop release.

`latest(asOf)` returns an indexed immutable snapshot only if both its evidence cutoff and availability time precede the requested boundary. The empty snapshot contains no strategy cards or opponent claims. The temporary `KnowledgeSnapshot` TypeScript shape is retained for the hand-binding integration; its `cards` field must always be empty, and the persisted table is `facts_snapshots`, not `knowledge_versions`.

Hand bindings persist the selected snapshot's digest and content. Facts refreshes affect subsequent hand pins, not earlier decisions. Future-dated receipts block materialization; private opponent cards are never inferred. The existing evidence materializer preserves only public showdown cards. Snapshot validation checks every retained encounter's event watermark, completion time and receipt time.

Audits recognize both new `framework` decision records and historical `knowledge` records. Each immutable audit binds to the original context hash and remains marked `asynchronous_audit_not_model_input`. The public history can read new audit rows and, when configured, the previous knowledge database's audit rows through a read-only connection. Legacy stores remain readable; the production facts worker does not invoke their publishers.

The worker receives only database paths and interval/batch parameters, with an empty environment and no inherited Node flags. It owns its derived SQLite writer, retries retained progress after errors and restarts with bounded delay. Its failure does not block live decisions or alter an existing hand's facts.

History queries recognize both legacy `context.knowledge` and DuelLoop `context.framework` / `proposal.framework` when loading audit evidence. The hand-audit refresh endpoint rereads the separate facts database, so an audit completed after the initial decision page load becomes visible without replacing the archived decision input. Legacy knowledge cards and pins retain their existing display format.
