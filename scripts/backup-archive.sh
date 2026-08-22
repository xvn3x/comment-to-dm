#!/usr/bin/env bash

# This file is sourced by verify-backup.sh and restore-backup.sh.
# Backups contain credentials, so extract only the three regular files that
# Comment to DM itself creates. Never unpack an arbitrary archive path tree.

extract_commentdm_backup() {
  local archive_path="$1"
  local destination="$2"
  local member line
  local -a members
  local -A seen=()
  local -a required=(database.dump production.env manifest.txt)

  mkdir -p "$destination"
  chmod 700 "$destination"

  if ! mapfile -t members < <(tar -tzf "$archive_path"); then
    echo "Backup archive could not be read." >&2
    return 1
  fi
  if (( ${#members[@]} != ${#required[@]} )); then
    echo "Backup archive must contain exactly database.dump, production.env and manifest.txt." >&2
    return 1
  fi

  for member in "${members[@]}"; do
    case "$member" in
      database.dump|production.env|manifest.txt) ;;
      *)
        echo "Backup archive contains an unexpected member: $member" >&2
        return 1
        ;;
    esac
    if [[ -n "${seen[$member]:-}" ]]; then
      echo "Backup archive contains a duplicate member: $member" >&2
      return 1
    fi
    seen[$member]=1
  done

  for member in "${required[@]}"; do
    if [[ -z "${seen[$member]:-}" ]]; then
      echo "Backup archive is missing $member." >&2
      return 1
    fi
  done

  # GNU tar starts each verbose record with the entry type. Backups created by
  # this project contain regular files only; reject links and device entries.
  while IFS= read -r line; do
    if [[ "${line:0:1}" != "-" ]]; then
      echo "Backup archive contains a non-regular member." >&2
      return 1
    fi
  done < <(tar -tvzf "$archive_path")

  for member in "${required[@]}"; do
    tar -xOzf "$archive_path" -- "$member" > "$destination/$member"
    chmod 600 "$destination/$member"
  done
}
