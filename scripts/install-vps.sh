#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

PROJECT_DIR="${COMMENTDM_PROJECT_DIR:-/opt/comment-to-dm}"
BACKUP_DIR="${COMMENTDM_BACKUP_DIR:-/var/backups/comment-to-dm}"
APP_USER="${COMMENTDM_APP_USER:-commentdm}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "Ошибка: $*" >&2
  exit 1
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  fail "запустите установщик через sudo: sudo bash scripts/install-vps.sh"
fi

if [[ ! -r /etc/os-release ]]; then
  fail "не удалось определить операционную систему"
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  fail "первая публичная версия установщика поддерживает только Ubuntu 24.04 LTS"
fi

if [[ -f "$PROJECT_DIR/.env" ]]; then
  fail "в $PROJECT_DIR уже есть установка. Скрипт не перезаписывает рабочие данные"
fi

normalize_host() {
  local raw="$1"
  raw="${raw#http://}"
  raw="${raw#https://}"
  raw="${raw%%/*}"
  raw="${raw%.}"

  if [[ "$raw" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    local part
    IFS='.' read -r -a parts <<< "$raw"
    for part in "${parts[@]}"; do
      (( part >= 0 && part <= 255 )) || fail "неверный IPv4-адрес: $raw"
    done
    printf '%s.sslip.io\n' "${raw//./-}"
    return
  fi

  if [[ ! "$raw" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ || "$raw" != *.* ]]; then
    fail "укажите публичный IPv4-адрес или доменное имя"
  fi
  printf '%s\n' "${raw,,}"
}

host_input="${1:-}"
if [[ -z "$host_input" ]]; then
  if [[ ! -t 0 ]]; then
    fail "передайте публичный IP первым аргументом"
  fi
  echo "Введите публичный IPv4-адрес VPS (например, 203.0.113.10)."
  echo "Если у вас уже есть домен, можно указать его вместо IP."
  read -r -p "> " host_input
fi

APP_DOMAIN="$(normalize_host "$host_input")"

echo
echo "Comment to DM будет доступен по адресу: https://$APP_DOMAIN"
echo "Устанавливаю Docker, приложение, HTTPS и ежедневные резервные копии."
echo

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git docker.io docker-compose-v2
systemctl enable --now docker

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi
usermod -aG docker "$APP_USER"

install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$PROJECT_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$PROJECT_DIR/incoming"

if git -C "$SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$SOURCE_DIR" archive --format=tar HEAD | tar -xf - -C "$PROJECT_DIR"
else
  fail "запускайте установщик из клонированного GitHub-репозитория"
fi

chmod 755 "$PROJECT_DIR/scripts/"*.sh

env_output="$(docker run --rm \
  -v "$PROJECT_DIR:/app" \
  -w /app \
  node:22-bookworm-slim \
  node scripts/generate-env.mjs "$APP_DOMAIN")"

chown -R "$APP_USER:$APP_USER" "$PROJECT_DIR"
chmod 600 "$PROJECT_DIR/.env"

cd "$PROJECT_DIR"
docker compose up -d --build

ready=0
for _ in $(seq 1 90); do
  if docker compose exec -T app node -e \
    'fetch("http://127.0.0.1:3000/ready").then(async response => { if (!response.ok) process.exit(1); const body = await response.json(); if (!body.ok || !body.database || !body.worker) process.exit(1); }).catch(() => process.exit(1))' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if (( ready != 1 )); then
  docker compose logs --tail=120 app >&2 || true
  fail "приложение не стало готово за 3 минуты. Скопируйте лог выше при обращении за помощью"
fi

install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$BACKUP_DIR"
install -m 0644 "$PROJECT_DIR/deploy/systemd/comment-to-dm-backup.service" /etc/systemd/system/
install -m 0644 "$PROJECT_DIR/deploy/systemd/comment-to-dm-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now comment-to-dm-backup.timer
systemctl start comment-to-dm-backup.service

echo
echo "Установка завершена."
echo "$env_output"
echo
echo "Адрес: https://$APP_DOMAIN"
echo "Откройте его в браузере и сохраните показанный выше пароль администратора."
echo "Если страница пока не открывается, подождите 1–2 минуты: Caddy получает HTTPS-сертификат."
echo "Дальше следуйте разделу «Настройка Meta» в docs/INSTALL-RU.md."
