# Async LLM research / 异步 LLM 研究

Application release **1.4.0**, based on 1.3.1 (`dc0f443`). The [iteration contract](research-iteration-1.4.md) was written before implementation. The original [v2 plan](async-llm-plan-v2.md) and [1.3.0 verification](async-llm-verification.md) remain historical evidence.

## Runtime contract

Jev remains the sole live action selector. Statistics and LLM research have independent workers; neither a remote analysis nor a research restart can resume the bot, clear its persistent stop or submit an action. Existing BASE_CARDS, candidate amounts and authorization/state/deadline checks remain in force. Jev retains its initial attempt plus at most three retries and its existing action deadline.

| Configuration   | Research calls                      | Advice in Jev requests                                                       |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `off` (default) | None                                | None                                                                         |
| `shadow`        | Enabled, with new eligible evidence | None                                                                         |
| `live`          | Enabled                             | Only approved, applicable published advice after explicit private activation |

Configured `off` always wins over a saved activation. Configured `shadow` cannot be elevated by a previous live approval. Configured `live` runs shadow until an operator confirms live consumption. A saved `off` or `shadow` overrides a live configuration. Each hand fixes its mode and complete knowledge bundle; disabling or withdrawing affects new hands. Old pins and request history are preserved.

The label “pure Jev” applies to off/shadow request inputs. Live advice uses `actionSource=jev` and `knowledgeSource=llm-assisted` only when advice actually reaches the request. A live hand without matching advice is recorded as such. Model probability and confidence are not poker equity or EV.

## Evidence and research

`EvidenceBuilder` reads raw SQLite in read-only mode. It selects at most 100 verified completed live hands independently per opponent across tables, plus a global review window. An incremental index in the research database is only a locator; every selected hand is rechecked against the raw archive and cutoff. Up to six sampled hands prioritize three significant cases and retain available profitable, losing and zero-profit comparisons. Samples retain completion/receipt cutoffs and explicit missingness. Opponent keys are stable hashes of public names, not verified identities.

Decision-visible examples contain sanitized facts, legal candidates, the recorded choice, same-hand session and presence/fingerprint of the actual Jev input. Later public showdowns and settlement are separate examples. Unrevealed cards, turn tokens, arbitrary historical model prose, endpoints and credentials are excluded. Frequency numerators and opportunity denominators are calculated in code. Missing prices and small samples remain explicit; missing showdowns do not establish bluff rates.

Research receives frozen batches and dedicated LLM configuration through an empty inherited worker environment. It returns data only. The reused model transport handles cancellation, model identity, usage and bounded retries. No generated script, shell command, tool call or SQL is executed. Strict schemas and evidence validation supplement independent operator review; they do not prove natural-language advice optimal or eliminate every prompt-injection risk.

The durable queue has one running job globally, at most eight pending by default, and coalesces pending evidence per task/scope. Pending replacement preserves queue age and all unprocessed trigger evidence; otherwise the older pending batch executes first. Significant events receive a bounded 60-second priority advantage, so older tasks continue to make progress. Running batches are immutable. New evidence does not cancel an ongoing analysis. No new eligible hands means no repeated paid task. Expiring leases and generations fence late results; an outbox persists completed results before proposal ingestion. Unknown responses remain unknown usage; cancellation does not prove a call was unbilled. Provider failures do not trigger a monetary threshold or local poker fallback.

## Configuration

Copy research settings from `.env.example` into a private `.env`. The new worker only uses `LLM_RESEARCH_API_KEY`; it does not automatically inherit `JEV_API_KEY`, the Arena key, `REASONING_API_KEY` or `DEEPSEEK_API_KEY`. The operator can assign an already owned compatible key locally.

```dotenv
BOT_STRATEGY=jev
ASYNC_LLM_MODE=off
LLM_RESEARCH_PROVIDER=deepseek
LLM_RESEARCH_PROTOCOL=messages
LLM_RESEARCH_BASE_URL=https://api.deepseek.com/anthropic
LLM_RESEARCH_MODEL=deepseek-flash
LLM_RESEARCH_API_KEY=
LLM_RESEARCH_THINKING=disabled
LLM_RESEARCH_EFFORT=high
LLM_RESEARCH_MAX_OUTPUT_TOKENS=4096
LLM_RESEARCH_TIMEOUT_MS=60000
LLM_RESEARCH_JOB_TIMEOUT_MS=120000
LLM_RESEARCH_MAX_RETRIES=3
LLM_RESEARCH_MAX_CONCURRENCY=1
LLM_RESEARCH_MAX_PENDING=8
LLM_RESEARCH_INITIAL_HANDS=10
LLM_RESEARCH_MIN_NEW_HANDS=10
LLM_RESEARCH_LEAK_MIN_NEW_HANDS=25
LLM_RESEARCH_INTERVAL_MS=15000
LLM_ADVICE_PUBLISH_POLICY=manual
LLM_ADVICE_MAX_ITEMS=3
```

The first opponent brief requires 10 eligible hands; refreshes require 10 newly observed hands, and global reviews 25. The worker waits 15 seconds between completed ticks; evidence preparation and inference add to the actual cadence. A server-confirmed hero investment of at least 20 BB, an absolute settled result of at least 30 BB, or a public showdown in a pot of at least 20 BB can trigger an earlier review. Trigger decisions and later settlement remain separately identified. Events are deduplicated per research scope against frozen jobs; exhausted failures and insufficient-evidence results wait for new evidence. Earlier triggers can produce provisional small-sample briefs, never conclusions that hidden cards or bluff rates are known.

Live and Evaluations show latest-run and all-history attempts, retries, successful/failed calls, completed/insufficient tasks and actual adoption. Run calls use the run's time window and can study older hands. Adoption counts decisions in live research mode with advice actually present in their saved request; it is not a profit or decision-quality score. Each scope shows its initial/refresh threshold, waiting reason, latest request and queue state. Public reads refresh asynchronously without controls or credentials. Call/job aggregates are cached for at most fifteen seconds; decision adoption continues to update incrementally, and a new run resets its view immediately.

Concurrency is intentionally limited to one in this release. Queue, evidence and retry limits constrain work; no cumulative cost limit blocks Jev. Research timeouts are independent of live action deadlines.

`LLM_RESEARCH_THINKING` controls the dedicated DeepSeek dialect: disabled omits effort, enabled uses its supported thinking parameters. Standard Messages uses adaptive thinking and standard Responses uses its existing reasoning-effort contract; this setting does not disable thinking on those transports. Requested and actual models are recorded and mismatches rejected. The canonical `deepseek-flash` API model has also passed a real dedicated Messages probe; see [production activation evidence](deepseek-live-activation.md).

Optional `LLM_RESEARCH_INPUT_PRICE_PER_MILLION`, `LLM_RESEARCH_OUTPUT_PRICE_PER_MILLION`, `LLM_RESEARCH_CACHE_READ_PRICE_PER_MILLION` and `LLM_RESEARCH_CACHE_CREATION_PRICE_PER_MILLION` produce explicit estimates. Empty prices remain unknown. Unpriced cache creation or a mismatched actual model keeps the corresponding cost unknown. Usage, price uncertainty and retries are recorded separately from Arena Run billing.

## Private commands

All commands below run locally or inside the server container; the public frontend never sends them. The CLI does not create an Arena connection.

```sh
# Free: freeze evidence. Use a historical cutoff for a later time-split comparison.
npm run research -- --op prepare --cutoff 2026-09-22T00:00:00.000Z --output data/research/prepared
npm run research -- --op status

# Explicit paid probe of exactly one frozen batch using configured research credentials.
npm run research -- --op diagnose --batch data/research/prepared/BATCH_ID.json --allow-paid --output data/research/probe

# Private review artifact; review source evidence and independent scenarios before approval.
npm run research -- --op inspect --proposal PROPOSAL_ID --output data/research/review
npm run research -- --op approve --proposal PROPOSAL_ID --actor owner --note "Evidence and independent scenarios reviewed" --scenarios evidence-reviewed,scope-reviewed,injection-reviewed,PROPOSAL_REQUIRED_SCENARIO
npm run research -- --op publish --proposal PROPOSAL_ID --revision 0 --ttl-ms 86400000 --actor owner
npm run research -- --op reject --proposal PROPOSAL_ID --actor owner --note "Unsupported hypothesis"
npm run research -- --op withdraw --publication PUBLICATION_ID --actor owner --note "Withdraw for later hands"

# Requires configured ASYNC_LLM_MODE=live. Existing hands retain their original pin.
npm run research -- --op mode --mode live --confirm-live --actor owner --note "Reviewed live experiment"
npm run research -- --op mode --mode shadow --actor owner --note "Observe without adopting"
npm run research -- --op mode --mode off --actor owner --note "Disable new research and advice"
```

Approval requires the fixed evidence/scope/injection review checks plus every scenario requested by the proposal. The operator supplies these confirmations; a model response cannot create them. Publishing uses explicit expected revision (CAS), separate publication sequence and a TTL no greater than 24 hours. Evidence must be younger than seven days. A newer unrelated statistics watermark does not invalidate otherwise compatible advice.

With `LLM_ADVICE_PUBLISH_POLICY=approved_recipe`, version 1.4 offers a separate bounded guidance contract:

```sh
npm run research -- --op approve-guidance --actor owner --note "Reviewed opponent-guidance-v1 evidence and scope contract"
# Server equivalent: sh scripts/manage.sh research --op approve-guidance --actor owner --note "Reviewed opponent-guidance-v1"
```

`opponent-guidance-v1` preserves the model's hypothesis, conditional guidance and limitations exactly after code checks evidence lineage, distinct counterexample hands, opponent scope, invalidation, content and length. Broad active-player scope requires an explicit pooled-sample limitation; narrow scope requires stratified support. Samples below 30 hands require a limited-sample caveat and expire within four hours. Unsupported numbers, hidden-card certainty, unconditional action instructions and executable/control text are rejected; request validation failures use the existing three retries. Research-only repair feedback supplies trusted contract categories and drafting suggestions, preserving the frozen evidence and recording each actual request body separately; rejected model prose is not fed back. Per-field drafting sizes are suggestions, while the total card limit remains mandatory. These checks establish a bounded evidence contract, not strategic correctness or profitability. Global free-text guidance still requires independent manual review.

Old `opponent-evidence-v2` template approval (`--op approve-recipe`) does not authorize the new contract. Its behavior and archived publications remain unchanged; there is no silent template fallback. New approvals do not rewrite previous hand pins. Latest trustworthy count snapshots can invalidate a suggestion before another LLM response and become part of the next immutable bundle. A model's scope refers to currently active players, not the table's six-seat capacity.

Advice selection uses supported streets, active-player count, original dealt positional roster, stack/bet buckets and current opponent keys. It selects at most 1–3 suggestions (default three), up to 300 text characters per suggestion/900 total and 4,096 serialized UTF-8 bytes. Excess advice is omitted with a reason before necessary current facts. Long analysis, hashes and proposal IDs stay out of the model projection; scope targets are rendered as current seats. These are character/byte limits, not token estimates.

## Storage, migration and recovery

| Database                  | Contents / writers                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_PATH`           | Existing authoritative history, decisions, actions, usage and stop markers; new content-addressed knowledge archive, availability records and lightweight hand references |
| `KNOWLEDGE_DATABASE_PATH` | Existing deterministic statistics and audit worker                                                                                                                        |
| `RESEARCH_DATABASE_PATH`  | Defaults to `<DATABASE_PATH>.research.sqlite`; research jobs/attempts, proposals, approvals, evidence refreshes, publications and private activation audit                |

Migrations add tables/triggers/indexes and a default-zero queue priority column. The research database also contains derived per-opponent locators and scope scheduling progress. Old events, decisions, costs, full hand bindings and hashes are not rewritten. Knowledge bundles archive the fixed base, statistics, advice, support metrics and selector before a hand can reference them; actual local availability is separate from evidence cutoff and provider receipt. Reviewed empty base bundles are timeless. Late identities may only select from the hand's existing archive.

An unchanged snapshot/advice hash avoids repeated large archive serialization. A changed snapshot is archived synchronously outside the action function; measurements include this limitation. Archives are content-addressed, have a finite size limit, and do not duplicate the full payload for every hand. Restart restores from the authoritative archive even if derived caches are missing. A missing, malformed or corrupted referenced archive produces the existing durable stop behavior instead of silently changing knowledge. Do not delete a referenced archive or stop marker to recover.

Supervisors deduplicate worker error/exit, wait for old workers to exit, use generation isolation and bounded backoff, and cancel restart during intentional stop. Statistics state messages omit unchanged full snapshots. Research failure never calls the private runtime resume endpoint.

## Compose backup, deployment and rollback

Continue using GitHub's existing no-cache multi-architecture build. Do not build or replace production automatically from a development test. When deployment is explicitly scheduled, drain the current hand, confirm official unseated placement and back up before the manual Compose update.

```sh
sh scripts/manage.sh backup
sh scripts/manage.sh update
sh scripts/manage.sh research --op status
# Private research CLI runs inside the existing Compose service:
sh scripts/manage.sh research --op mode --mode off --actor owner --note "Disable experiment"
```

`backup` pauses both derived workers through the authenticated loopback API, uses SQLite's online backup API for all three databases, then restarts only the workers. It never resumes the poker Runtime. Raw backups contain referenced immutable archives; research backups retain proposal/approval/attempt lineage. Each research attempt archives its exact serialized HTTP JSON body (including fixed instructions, schema and frozen evidence), body SHA-256 and input SHA-256 before network submission, including retried or failed attempts; authentication headers are excluded and this private ledger is never part of the public projection. Run the release backup after draining, and avoid concurrent private publication commands during backup. Store the three resulting files as one backup set with mode 600. Do not copy SQLite's live main file without WAL contents.

Restore all three files into an offline persistent volume. For runtime recovery, retain raw archives even if statistics or research must be rebuilt. A rollback binary must understand the new lightweight hand references; returning to 1.2.4 requires restoring its complete pre-upgrade backup offline, not deleting new records or pretending the old binary can read new pins. Retain the newer backup separately. Ordinary advice rollback uses withdraw/off at hand boundaries and preserves history.

## Free preparation and explicit paired evaluation

```sh
npm run research -- --op pair-prepare --run RUN_ID --limit 30 --partition holdout --output data/research/pairs
npm run research -- --op pair-run --plan data/research/pairs/plan.json --allow-paid --output data/research/paired-results
```

Preparation freezes the approved advice set, completed evidence IDs, contexts, candidates and complete Jev request hashes. It excludes research hands and any hand starting before the latest research/support evidence. Development and holdout are split by stable hand hash; each sampled hand contributes one decision. The default prepares up to 30 eligible hands; missing samples and rejection reasons remain visible. Run alternates A/C order, records both requests, attempts, identities, input bytes, disagreements, errors and P50/P95/P99 latency in private artifacts and a separate evaluation ledger. A changed prompt, candidate or actual request invalidates the comparison.

This is explicitly a **posthoc time-split experiment**: advice produced now was not available during the original run. Do not tune advice using holdout results and continue calling them unseen. A/B (off/shadow) request identity is covered by controlled tests; A/C measures advice's incremental input/behavior change. No alternative action inherits historical profit.

## Real Arena experiment

Real supplier calls, live activation and production deployment are distinct explicit operations. For a later Arena trial, pre-register balanced A/C blocks (for example A–C–C–A, equal completed-hand targets), freeze the advice set and base policy, and switch the private advice mode at hand boundaries using the CLI above. Do not run another account at the same table. Record every assigned hand including failures and platform timeouts, opponent mix, blind level and missing settlements. The supplied CLI enables switching and records hand pins; it does not automatically conduct an Arena block schedule.

Report per-hand bb/100 and confidence intervals grouped by session/time block, not by decision. Existing Run profit summaries are observed outcomes, not a controlled causal estimate. The current release delivers the controlled engineering chain and explicit model/evaluation entry points; supplier latency, Arena adoption and profitability require their own executed evidence.
