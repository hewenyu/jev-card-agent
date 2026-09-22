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
    mkdir -p data/backups
    chmod 700 data/backups
    backup_paths=$(docker compose exec -T app node --input-type=module < "$script_dir/backup-database.mjs")
    while IFS= read -r backup_path; do
      case "$backup_path" in
        /app/data/backups/jev-*.sqlite|/app/data/backups/knowledge-*.sqlite|/app/data/backups/research-*.sqlite) ;;
        *) printf '%s\n' 'Backup failed: unexpected container path' >&2; exit 1 ;;
      esac
      docker compose cp "app:$backup_path" data/backups/
      chmod 600 "data/backups/$(basename "$backup_path")"
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
