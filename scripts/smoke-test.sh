#!/usr/bin/env sh
set -eu

set -a
# shellcheck disable=SC1091
. ./.env
set +a

API_URL=${SMOKE_API_URL:-http://localhost:4000/api}
WEB_URL=${SMOKE_WEB_URL:-http://localhost:3000}

wait_url(){
  url=$1; name=$2; retries=${3:-60}
  i=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -ge "$retries" ] && { echo "[FAIL] $name не ответил: $url"; docker compose ps; exit 1; }
    sleep 2
  done
  echo "[OK] $name"
}

wait_url "$API_URL/health" "API health"
wait_url "$WEB_URL/login" "Web login"

LOGIN_BODY=$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
LOGIN=$(curl -fsS -H 'Content-Type: application/json' -d "$LOGIN_BODY" "$API_URL/auth/login") || { echo "[FAIL] Авторизация"; exit 1; }
TOKEN=$(printf '%s' "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "[FAIL] JWT не получен"; exit 1; }
echo "[OK] Авторизация"

curl -fsS -H "Authorization: Bearer $TOKEN" "$API_URL/integrations" >/dev/null || { echo "[FAIL] Защищённый endpoint integrations"; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$API_URL/dashboard/overview?days=1&compare=false" >/dev/null || { echo "[FAIL] Dashboard endpoint"; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$API_URL/warehouse/imports" >/dev/null || { echo "[FAIL] Warehouse endpoint"; exit 1; }
echo "[OK] Защищённые API endpoints"

if [ "${SMOKE_TEST_UZUM:-0}" = "1" ]; then
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' "$API_URL/integrations/UZUM/test" >/dev/null \
    || { echo "[FAIL] Live-проверка Uzum"; exit 1; }
  echo "[OK] Live-проверка Uzum"
fi

if [ "${SMOKE_TEST_TELEGRAM:-0}" = "1" ]; then
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' "$API_URL/integrations/TELEGRAM/test" >/dev/null \
    || { echo "[FAIL] Live-проверка Telegram (getMe + sendMessage)"; exit 1; }
  echo "[OK] Live-проверка Telegram: тестовое сообщение отправлено"
fi

echo "Smoke-test завершён. Для live-проверки сохранённых интеграций: SMOKE_TEST_UZUM=1 SMOKE_TEST_TELEGRAM=1 ./scripts/smoke-test.sh"
