#!/bin/sh
# Run from the directory containing compose.yaml and the private .env file.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
action=${1:-status}
if [ "$#" -gt 0 ]; then shift; fi

drain() {
  running=$(docker compose ps --status running -q app)
  if [ -n "$running" ]; then
    docker compose exec -T app node --input-type=module < "$script_dir/drain-runtime.mjs"
  fi
}

# Inspect only a newly returned backup; delete only if its bytes still match the host copy.
backup_file() {
  docker compose exec -T app node --input-type=module - "$@" <<'JS'
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, unlinkSync } from 'node:fs';
const [path, expected] = process.argv.slice(2);
if (!/^\/app\/data\/backups\/(?:jev|knowledge|research|facts|duelloop|protocol-development|protocol-final)-[\w.-]+\.(?:sqlite\.gz|json)$/.test(path))
  throw new Error('Unexpected backup path');
const before = lstatSync(path);
if (!before.isFile()) throw new Error('Backup is not a regular file');
const hash = createHash('sha256');
for await (const chunk of createReadStream(path)) hash.update(chunk);
const digest = hash.digest('hex');
const after = lstatSync(path);
if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
  throw new Error('Backup changed during verification');
if (expected) {
  if (digest !== expected) throw new Error('Backup changed after copying; preserved container copy');
  unlinkSync(path);
} else process.stdout.write(`${digest} ${after.size}\n`);
JS
}

case "$action" in
  start)
    running=$(docker compose ps --status running -q app)
    if [ -z "$running" ]; then
      docker compose up -d app
    fi
    ;;
  stop)
    drain
    docker compose stop app
    ;;
  restart)
    drain
    docker compose up -d --no-deps --force-recreate app
    ;;
  update)
    drain
    docker compose pull app
    docker compose up -d --no-deps --force-recreate app
    ;;
  status)
    docker compose ps
    exit 0
    ;;
  resume)
    docker compose exec -T app node --input-type=module < "$script_dir/resume-runtime.mjs"
    ;;
  research)
    docker compose exec -T app node dist/cli/research.js "$@"
    exit 0
    ;;
  logs)
    docker compose logs --tail 100 -f "$@" app
    exit 0
    ;;
  backup)
    drain
    mkdir -p data/backups
    chmod 700 data/backups
    backup_paths=$(docker compose exec -T app node --input-type=module < "$script_dir/backup-database.mjs")
    while IFS= read -r backup_path; do
      case "$backup_path" in
        /app/data/backups/jev-*.sqlite.gz|/app/data/backups/knowledge-*.sqlite.gz|/app/data/backups/research-*.sqlite.gz|/app/data/backups/facts-*.sqlite.gz|/app/data/backups/duelloop-*.sqlite.gz|/app/data/backups/protocol-development-*.json|/app/data/backups/protocol-final-*.json) ;;
        *) printf '%s\n' 'Backup failed: unexpected container path' >&2; exit 1 ;;
      esac
      metadata=$(backup_file "$backup_path")
      digest=${metadata% *}
      bytes=${metadata##* }
      case "$digest" in *[!a-f0-9]*|'') printf '%s\n' 'Invalid backup digest' >&2; exit 1 ;; esac
      if [ "${#digest}" -ne 64 ]; then printf '%s\n' 'Invalid backup digest' >&2; exit 1; fi
      case "$bytes" in *[!0-9]*|'') printf '%s\n' 'Invalid backup size' >&2; exit 1 ;; esac
      available_kb=$(df -Pk data/backups | awk 'END {print $4}')
      if [ "$available_kb" -lt $((bytes / 1024 + 1048577)) ]; then
        printf '%s\n' 'Insufficient host backup space; runtime and research remain stopped' >&2; exit 1
      fi
      target="data/backups/$(basename "$backup_path")"
      if [ -e "$target" ]; then printf '%s\n' 'Backup destination exists; preserving both copies' >&2; exit 1; fi
      incoming=$(mktemp -d data/backups/.incoming-XXXXXX)
      docker compose cp "app:$backup_path" "$incoming/"
      copied="$incoming/$(basename "$backup_path")"
      chmod 600 "$copied"
      if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$copied")
      else
        actual=$(shasum -a 256 "$copied")
      fi
      if [ "${actual%% *}" != "$digest" ]; then
        printf '%s\n' 'Backup copy checksum mismatch; preserving container copy' >&2; exit 1
      fi
      mv -n "$copied" "$target"
      if [ -e "$copied" ]; then printf '%s\n' 'Backup destination changed; preserving copies' >&2; exit 1; fi
      rmdir "$incoming"
      backup_file "$backup_path" "$digest"
      printf 'Consistent SQLite backup: data/backups/%s\n' "$(basename "$backup_path")"
    done <<EOF
$backup_paths
EOF
    exit 0
    ;;
  *)
    printf '%s\n' 'Usage: sh scripts/manage.sh {start|stop|restart|update|resume|status|logs|backup|research}' >&2
    exit 2
    ;;
esac
docker compose ps
