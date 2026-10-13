#!/usr/bin/env bash
# Quick-туннель Cloudflare для Telegram Mini App: наружу смотрит шлюз
# scripts/miniapp-gateway.mjs (порт 3250), а не веб напрямую — см. CLAUDE.md.
#
# У quick-туннеля адрес *.trycloudflare.com меняется при каждом запуске, поэтому
# скрипт сам дописывает новый адрес в TELEGRAM_MINIAPP_URL (.env), перезапускает
# uzum-api (иначе бот отдаёт старую ссылку) и присылает новый адрес в Telegram.
# Постоянный адрес = named-туннель на своём домене, тогда этот скрипт не нужен.
#
# Запуск: через юнит uzum-miniapp-tunnel.service (systemd --user).
set -uo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${MINIAPP_GATEWAY_PORT:-3250}"
CLOUDFLARED="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
LOG="$HOME/.local/state/uzum-miniapp-tunnel.log"
mkdir -p "$(dirname "$LOG")"

cd "$APP"
: >"$LOG"
"$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >>"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill "$TUNNEL_PID" 2>/dev/null' TERM INT

HOSTNAME_URL=""
for _ in $(seq 1 45); do
  HOSTNAME_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)"
  [ -n "$HOSTNAME_URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
  sleep 2
done

if [ -z "$HOSTNAME_URL" ]; then
  echo "адрес туннеля не получен, подробности в $LOG" >&2
  wait "$TUNNEL_PID"
  exit 1
fi

URL="$HOSTNAME_URL/miniapp"
echo "адрес мини-приложения: $URL"

CURRENT="$(grep -oP '^TELEGRAM_MINIAPP_URL="?\K[^"]*' "$APP/.env" 2>/dev/null | head -1)"
if [ "$CURRENT" != "$URL" ]; then
  if grep -q '^TELEGRAM_MINIAPP_URL=' "$APP/.env"; then
    sed -i "s#^TELEGRAM_MINIAPP_URL=.*#TELEGRAM_MINIAPP_URL=\"$URL\"#" "$APP/.env"
  else
    printf '\nTELEGRAM_MINIAPP_URL="%s"\n' "$URL" >>"$APP/.env"
  fi
  systemctl --user restart uzum-api.service || echo "не удалось перезапустить uzum-api" >&2
  timeout 60 npx --no-install tsx apps/api/scripts/notify-telegram.ts \
    "📱 Новый адрес мини-приложения: $URL — нажмите /start, чтобы обновить кнопку в меню." >/dev/null 2>&1 || true
fi

wait "$TUNNEL_PID"
