#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

PROJECT_DIR="${COMMENTDM_PROJECT_DIR:-/opt/comment-to-dm}"
BACKUP_DIR="${COMMENTDM_BACKUP_DIR:-/var/backups/comment-to-dm}"
archive_path="${1:-}"

if [[ -z "$archive_path" ]]; then
  archive_path="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'comment-to-dm-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi

if [[ -z "$archive_path" || ! -f "$archive_path" ]]; then
  echo "Backup archive was not found." >&2
  exit 2
fi

if [[ ! -f "$PROJECT_DIR/docker-compose.yml" ]]; then
  echo "Comment to DM installation was not found at $PROJECT_DIR." >&2
  exit 2
fi

archive_path="$(readlink -f "$archive_path")"
checksum_path="$archive_path.sha256"
work_dir="$(mktemp -d)"
test_database="commentdm_backup_verify_$(date -u +%Y%m%d%H%M%S)_$$"
database_created=0

cleanup() {
  if (( database_created == 1 )); then
    cd "$PROJECT_DIR"
    docker compose exec -T db sh -lc \
      'dropdb --if-exists --username="$POSTGRES_USER" "$1"' _ "$test_database" > /dev/null 2>&1 || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

if [[ -f "$checksum_path" ]]; then
  (
    cd "$(dirname "$archive_path")"
    sha256sum -c "$(basename "$checksum_path")"
  )
fi

tar -xzf "$archive_path" -C "$work_dir"
test -s "$work_dir/database.dump"
test -s "$work_dir/production.env"

cd "$PROJECT_DIR"
docker compose exec -T db pg_restore --list < "$work_dir/database.dump" > /dev/null
docker compose exec -T db sh -lc \
  'createdb --username="$POSTGRES_USER" "$1"' _ "$test_database"
database_created=1

docker compose exec -T db sh -lc \
  'pg_restore --username="$POSTGRES_USER" --dbname="$1" --exit-on-error --no-owner --no-privileges' \
  _ "$test_database" < "$work_dir/database.dump"

required_tables="$(docker compose exec -T db sh -lc \
  'psql --username="$POSTGRES_USER" --dbname="$1" --tuples-only --no-align --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = '\''public'\'' AND table_name IN ('\''schema_migrations'\'', '\''meta_connection'\'', '\''rules'\'', '\''events'\'', '\''jobs'\'', '\''worker_leases'\'', '\''link_tracking'\'');"' \
  _ "$test_database")"

if [[ "$required_tables" != "7" ]]; then
  echo "The restored database is missing required tables ($required_tables/7)." >&2
  exit 5
fi

row_counts="$(docker compose exec -T db sh -lc \
  'psql --username="$POSTGRES_USER" --dbname="$1" --tuples-only --no-align --field-separator=, --command="SELECT (SELECT count(*) FROM rules), (SELECT count(*) FROM events), (SELECT count(*) FROM jobs);"' \
  _ "$test_database")"

echo "Backup verified in disposable database $test_database (rules,events,jobs=$row_counts)."
