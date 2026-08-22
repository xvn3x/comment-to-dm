#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

PROJECT_DIR="${COMMENTDM_PROJECT_DIR:-/opt/comment-to-dm}"
REPOSITORY_URL="${COMMENTDM_REPOSITORY_URL:-https://github.com/xvn3x/comment-to-dm.git}"
ref="${1:-}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Запустите обновление через sudo: sudo /opt/comment-to-dm/scripts/update-vps.sh" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "Рабочая установка не найдена в $PROJECT_DIR." >&2
  exit 1
fi

if [[ -z "$ref" ]]; then
  echo "Укажите проверенный тег релиза, например: $0 v0.8.1" >&2
  exit 2
fi

if [[ ! "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$ ]]; then
  echo "Обновление принимает только тег релиза вида v0.8.1, а не плавающую ветку: $ref" >&2
  exit 2
fi

work_dir="$(mktemp -d /tmp/comment-to-dm-update-XXXXXX)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

git clone --quiet --depth 1 --branch "$ref" "$REPOSITORY_URL" "$work_dir/source"
if [[ "$(git -C "$work_dir/source" cat-file -t "refs/tags/$ref" 2>/dev/null || true)" != "tag" ]]; then
  echo "Тег $ref не является аннотированным релизным тегом." >&2
  exit 3
fi
release_id="$(git -C "$work_dir/source" rev-parse HEAD)"
archive_path="$PROJECT_DIR/incoming/comment-to-dm-${release_id}.tar.gz"

git -C "$work_dir/source" archive --format=tar.gz --output="$archive_path" HEAD
chown "$(stat -c '%U:%G' "$PROJECT_DIR")" "$archive_path"
chmod 600 "$archive_path"

sed -i 's/\r$//' "$PROJECT_DIR/scripts/deploy-release.sh"
bash "$PROJECT_DIR/scripts/deploy-release.sh" "$release_id" "$archive_path"
