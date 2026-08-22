#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/backup-archive.sh"

test_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT

mkdir -p "$test_root/source" "$test_root/output"
printf 'database' > "$test_root/source/database.dump"
printf 'environment' > "$test_root/source/production.env"
printf 'manifest' > "$test_root/source/manifest.txt"
tar -C "$test_root/source" -czf "$test_root/valid.tar.gz" database.dump production.env manifest.txt
extract_commentdm_backup "$test_root/valid.tar.gz" "$test_root/output"
cmp "$test_root/source/database.dump" "$test_root/output/database.dump"
cmp "$test_root/source/production.env" "$test_root/output/production.env"

printf 'unexpected' > "$test_root/source/extra.txt"
tar -C "$test_root/source" -czf "$test_root/extra.tar.gz" database.dump production.env manifest.txt extra.txt
if extract_commentdm_backup "$test_root/extra.tar.gz" "$test_root/rejected-extra"; then
  echo "Archive with an extra member was accepted." >&2
  exit 1
fi

mkdir -p "$test_root/nonregular-source/database.dump"
printf 'environment' > "$test_root/nonregular-source/production.env"
printf 'manifest' > "$test_root/nonregular-source/manifest.txt"
tar -C "$test_root/nonregular-source" -czf "$test_root/nonregular.tar.gz" database.dump production.env manifest.txt
if extract_commentdm_backup "$test_root/nonregular.tar.gz" "$test_root/rejected-nonregular"; then
  echo "Archive with a non-regular member was accepted." >&2
  exit 1
fi

echo "Backup archive safety checks passed."
