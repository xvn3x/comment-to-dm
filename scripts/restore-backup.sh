#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

PROJECT_DIR="${COMMENTDM_PROJECT_DIR:-/opt/comment-to-dm}"
archive_path="${1:-}"

if [[ -z "$archive_path" || ! -f "$archive_path" ]]; then
  echo "Usage: COMMENTDM_RESTORE_CONFIRM=RESTORE_COMMENT_TO_DM $0 /path/to/backup.tar.gz" >&2
  exit 2
fi

if [[ "${COMMENTDM_RESTORE_CONFIRM:-}" != "RESTORE_COMMENT_TO_DM" ]]; then
  echo "Restore refused. Set COMMENTDM_RESTORE_CONFIRM=RESTORE_COMMENT_TO_DM after checking the archive path." >&2
  exit 3
fi

archive_path="$(readlink -f "$archive_path")"
work_dir="$(mktemp -d)"

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

"$PROJECT_DIR/scripts/verify-backup.sh" "$archive_path"
pre_restore_archive="$("$PROJECT_DIR/scripts/backup.sh" pre-restore)"
tar -xzf "$archive_path" -C "$work_dir"

cd "$PROJECT_DIR"
docker compose stop app

echo "Application stopped. A safety backup was created at $pre_restore_archive."
echo "If the restore fails from this point, leave the app stopped and restore the safety archive."

docker compose exec -T db sh -lc \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'

docker compose exec -T db sh -lc \
  'pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --exit-on-error --no-owner --no-privileges' \
  < "$work_dir/database.dump"

if [[ "${COMMENTDM_RESTORE_ENV:-0}" == "1" ]]; then
  install -m 600 "$work_dir/production.env" "$PROJECT_DIR/.env"
fi

docker compose up -d app
echo "Restore completed. Check /health, /ready, the Instagram connection and the rules before resuming traffic."
