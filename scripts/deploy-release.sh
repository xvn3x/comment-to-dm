#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

PROJECT_DIR="${COMMENTDM_PROJECT_DIR:-/opt/comment-to-dm}"
release_id="${1:-}"
archive_path="${2:-$PROJECT_DIR/incoming/comment-to-dm-${release_id}.tar.gz}"

if [[ ! "$release_id" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release id must be a full 40-character Git commit SHA." >&2
  exit 2
fi

if [[ ! -f "$archive_path" ]]; then
  echo "Release archive was not found: $archive_path" >&2
  exit 2
fi

archive_path="$(readlink -f "$archive_path")"
staging_root="$PROJECT_DIR/.deploy"
mkdir -p "$staging_root" "$PROJECT_DIR/incoming"
staging_dir="$(mktemp -d "$staging_root/${release_id}-XXXXXX")"
rollback_tag="rollback-$(date -u +%Y%m%dT%H%M%SZ)"

cleanup() {
  rm -rf -- "$staging_dir"
  rm -f -- "$archive_path"
}
trap cleanup EXIT

if tar -tzf "$archive_path" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Release archive contains an unsafe path." >&2
  exit 3
fi

tar -xzf "$archive_path" -C "$staging_dir"

for required_file in Dockerfile docker-compose.yml package.json scripts/backup.sh; do
  if [[ ! -f "$staging_dir/$required_file" ]]; then
    echo "Release archive is missing $required_file." >&2
    exit 3
  fi
done

install -m 600 "$PROJECT_DIR/.env" "$staging_dir/.env"
"$PROJECT_DIR/scripts/backup.sh" pre-deploy

if docker image inspect comment-to-dm-app:latest > /dev/null 2>&1; then
  docker image tag comment-to-dm-app:latest "comment-to-dm-app:$rollback_tag"
fi

docker compose -p comment-to-dm -f "$staging_dir/docker-compose.yml" build app
docker compose -p comment-to-dm -f "$staging_dir/docker-compose.yml" up -d --no-build app

ready=0
for _ in $(seq 1 60); do
  if docker compose -p comment-to-dm -f "$staging_dir/docker-compose.yml" exec -T app \
    node -e 'fetch("http://127.0.0.1:3000/ready").then(async response => { if (!response.ok) process.exit(1); const body = await response.json(); if (!body.ok || !body.database || !body.worker) process.exit(1); }).catch(() => process.exit(1))'; then
    ready=1
    break
  fi
  sleep 2
done

if (( ready != 1 )); then
  echo "New release did not become ready. Rolling back to $rollback_tag." >&2
  docker compose -p comment-to-dm -f "$staging_dir/docker-compose.yml" logs --tail=200 app >&2 || true
  if docker image inspect "comment-to-dm-app:$rollback_tag" > /dev/null 2>&1; then
    docker image tag "comment-to-dm-app:$rollback_tag" comment-to-dm-app:latest
    docker compose -p comment-to-dm -f "$PROJECT_DIR/docker-compose.yml" up -d --no-build app
  fi
  exit 4
fi

tar -xzf "$archive_path" -C "$PROJECT_DIR"
chmod 755 "$PROJECT_DIR/scripts/backup.sh" "$PROJECT_DIR/scripts/verify-backup.sh" \
  "$PROJECT_DIR/scripts/restore-backup.sh" "$PROJECT_DIR/scripts/deploy-release.sh"

echo "$release_id" > "$PROJECT_DIR/.deployed-release"
chmod 600 "$PROJECT_DIR/.deployed-release"
echo "Release $release_id deployed successfully. Rollback image: comment-to-dm-app:$rollback_tag"
