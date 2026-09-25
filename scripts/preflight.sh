#!/usr/bin/env sh
set -eu

CONFIG_ONLY=false
[ "${1:-}" = "--config-only" ] && CONFIG_ONLY=true

fail(){ echo "[FAIL] $1" >&2; exit 1; }
ok(){ echo "[OK] $1"; }

[ -f .env ] || fail ".env не найден"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL пуст"
[ ${#JWT_SECRET} -ge 32 ] || fail "JWT_SECRET короче 32 символов"
[ -n "${APP_ENCRYPTION_KEY:-}" ] || fail "APP_ENCRYPTION_KEY пуст"
[ ${#ADMIN_PASSWORD} -ge 12 ] || fail "ADMIN_PASSWORD короче 12 символов"
[ -n "${WEB_ORIGIN:-}" ] || fail "WEB_ORIGIN пуст"

KEY_BYTES=$(printf '%s' "$APP_ENCRYPTION_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ')
[ "$KEY_BYTES" = "32" ] || fail "APP_ENCRYPTION_KEY должен декодироваться ровно в 32 байта"
ok "Переменные окружения"

docker compose config >/dev/null || fail "docker compose config невалиден"
ok "Docker Compose конфигурация"

if [ "$CONFIG_ONLY" = false ]; then
  npm ci --ignore-scripts --no-audit --no-fund
  npm test
  npm run test:types:api
  npm run lint -w apps/web
  NEXT_PUBLIC_API_URL=/api NEXT_OUTPUT_STANDALONE=false NEXT_TELEMETRY_DISABLED=1 npm run build -w apps/web
  ok "Unit-тесты и web production build"
fi
