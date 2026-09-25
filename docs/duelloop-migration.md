# Copy-only DuelLoop migration

Run `npm run migrate:duelloop -- --database data/jev.sqlite --env .env --output data/migration/review-001` from the repository root. The command uses Node 24 SQLite online backups, makes independent immutable recovery snapshots, and upgrades only working copies. It never starts a bot, calls a model, clears an execution blocker, or edits the source `.env` or source databases. For a coordinated release, first drain the current hand and stop the derived writers; online backups are consistent per database, not a cross-database transaction.

The output directory must not already exist. It is private (0700); `.env.next`, the manifest and database files are 0600. Keep it under ignored `data/`. It contains `backups/` (original schemas), `working/` (new runtime paths), `.env.next`, and a sanitized `manifest.json`. All existing raw, legacy knowledge, legacy research, facts and SDK stores are copied, together with private development/final protocol files when present; seed contents are excluded from the manifest. Missing optional stores are reported; new raw host tables and a physically separate SDK database are initialized only in `working/`.

Deployment preparation on 2026-09-25 found a raw database larger than 10 GB and
a legacy knowledge database larger than 2 GB. Reading each complete backup into
one Buffer to calculate SHA-256 can fail at this scale or exhaust memory.
Database snapshot hashes are therefore calculated from a read stream with 64 KiB
chunks; the digest still covers every byte of the completed SQLite backup.
Hashing memory does not grow with database size. This does not reduce required
disk space: budget for both immutable backups and upgraded working copies, and
retain source files until the new deployment has been verified.

The Compose handoff consists of a **standalone** `compose.json` and private
`.env.compose`. The latter maps all five databases and both protocols to
`/app/data`; the only database mount is `./working:/app/data`. Never combine this
file with the repository's `compose.yaml`: that file mounts the original named
volume and overrides `DATABASE_PATH`. `.env.next` remains for running the working
copies directly on the host, not for a container. The generated service runs with
the migration owner's numeric UID/GID so 0600 files remain readable and writable
without relaxing permissions. When transferring the directory, preserve or
correct ownership for the operator on the destination host.

After draining/stopping the old service and reviewing the manifest, set
`JEV_IMAGE` to the verified release digest and start the copied service:

```sh
JEV_IMAGE=hewenyulucky/jev-card-agent@sha256:REVIEWED_DIGEST \
  docker compose -p jev-migrated -f data/migration/review-001/compose.json up -d
docker compose -p jev-migrated -f data/migration/review-001/compose.json ps
```

For subsequent `scripts/manage.sh` operations, explicitly select this same file
and project so an update cannot accidentally target the old named volume:

```sh
export COMPOSE_FILE="$PWD/data/migration/review-001/compose.json"
export COMPOSE_PROJECT_NAME=jev-migrated
export JEV_IMAGE=hewenyulucky/jev-card-agent@sha256:REVIEWED_DIGEST
sh scripts/manage.sh status
```

The isolated preview binds `127.0.0.1:18787` by default; set `CONSOLE_PORT=8787`
only after stopping the prior service. Bot and research autostart stay false in
both private env files. Review the preserved blockers and protocols before editing
those flags or explicitly resuming. `docker compose config` renders private
credentials: do not publish its output. Working-copy changes survive container
recreation; `backups/` and source files are not mounted or modified. For a rollback,
copy backups into a new rollback working directory and use the old release and
original private configuration with paths mapped to that directory; never mount
the immutable backups writable.

The manifest records snapshot SHA-256, SQLite `quick_check`, table row counts, preserved pending-action/decision-block counts, and legacy reader validation. It contains no environment values, prompts, cards or decision contents. `.env.next` preserves credentials and provider settings using literal single-quoted values where possible so Compose cannot expand `$` inside secrets. Values containing an apostrophe use double quotes only when they contain no dollar sign, double quote or backslash; values outside this common Node/Compose-safe subset fail migration instead of changing credentials. Node dotenv round-trip validation is required, and a synthetic credential regression checks Compose parsing when its CLI is installed. It removes `ASYNC_LLM_*`, `LLM_ADVICE_*`, `LLM_RESEARCH_*`, `REASONING_MODE` and `HYBRID_TIMEOUT_MS`, and disables bot/research autostart. `FACTS_ENABLED` preserves the prior explicit value or inherits `RESEARCH_ENABLED`. Legacy stores remain accessible through read-only history readers. Review and configure fresh development/final protocols before enabling research.

If migration fails, original files stay untouched. The incomplete output is retained privately for diagnosis; choose a new output directory for retries. Never point the SDK at the raw database. Paths that alias the same physical input (including symbolic links and hard links) are rejected. To restore, use the unchanged backups with the previous application release and its private original environment, after stopping all writers. Do not run the old and new bot simultaneously.

Copying an existing SDK database does not upgrade its strategy behavior contract.
An active release from the earlier session-less contract is rejected with
`VERSION_INCOMPATIBLE` by the corrected runtime; its old validation report cannot
authorize current behavior. The research worker also requires a compatible base
release, so enabling research cannot automatically revalidate that old baseline.
Keep autostart disabled in this case. Retain the original database and release
history, use the compatible application for rollback, and review a separate
behavior-version migration before activation. Do not delete release records or
change the scope to bypass validation. The container restore drill below verifies
data access and persistence, not conversion of old release approvals.

## Release backup and isolated validation

`sh scripts/manage.sh backup` drains the live hand and confirms official unseated placement before stopping research writers. It backs up all five database categories with SQLite online backup and verifies each result. Existing private development/final protocol files are also copied, without printing seeds. It deliberately leaves runtime and research stopped for a safe release boundary; operator pause records are preserved and no automatic resume command is sent. Resume explicitly only after the release or backup review. Existing database histories are retained.

Production installation/image validation uses a temporary project with its own Compose file and volume, `READ_ONLY_DEMO=true`, and `AUTO_START_BOT=false`; no live credentials or production database mount is passed. This verifies a clean `npm ci --omit=dev`, fresh image build and HTTP startup without entering the Arena.

Validation on 2026-09-24: `node scripts/verify-production-install.mjs` completed a clean production install (310 packages, npm audit reported zero vulnerabilities), a `docker compose build --no-cache --pull`, isolated container startup, HTTP health/idle-runtime checks, and serving the frontend build. The private test project, volume, network and image were removed afterward. No Arena connection or live credentials were used. This verifies packaging/startup; it is not a live poker or profitability result. Rerun the command for future releases; `--install-only` limits it to clean production dependency installation/import.

To verify the complete handoff against an already built production image, run:

```sh
npm run build
node --import tsx scripts/verify-migration-compose.mjs --image REVIEWED_LOCAL_IMAGE
```

The script creates all five synthetic schema-valid databases, adds committed rows
without checkpointing WAL, migrates them, and starts the generated Compose file
with only isolated image/port/network settings changed. It verifies HTTP history
and decision readers, both protocol files, all five writable paths, preserved
unknown-action/decision blockers and persistence after forced container recreation.
It then restores new copies from the original backup files, starts those copies,
and repeats the readers and blocker checks. Source and backup bytes must remain
unchanged. Containers have an internal-only network, no model/Arena credentials,
and both autostart switches disabled. The output distinguishes restoring original
data with the selected production image from validating a previous-release image;
the latter must still be checked for the operator's chosen rollback release.
HTTP checks run inside the container through localhost, so they work even when
Docker's internal network prevents publishing ports to the host. The compiled
coordinator SHA-256 must match the local production build.

Audit correction validation on 2026-09-24: the no-cache production image
`jev-card-agent:v2-audit-fixes` passed every check above against the full synthetic
migration and restored-original copies. All five committed WAL markers, history
and decisions, private protocol pair, preserved blockers and new persistence
markers survived recreation. Original main/WAL files and backup hashes remained
unchanged. The image coordinator matched local `dist` at SHA-256
`c2559d18c899c25e99d3eca4c9b5a2d49377398ba31567c634ef4499f321cb47`.
The final local `linux/arm64` image ID was
`sha256:e557b653cbe0fd9d55526b51cede38a923f5846d8a45c86243233d9f49287bea`.
This final build installed DuelLoop from the official `v0.2.2` GitHub Release URL
with its locked integrity; both Docker stages used clean `npm ci` without a vendor
package copy. Container checks confirmed the installed package source/integrity,
SDK version and absence of `/app/vendor`.
No previous-release image was tested; this validates copy restoration and current
release readers. No production data, credentials, Arena connections or model
requests were used. Temporary containers, networks and data were removed.
