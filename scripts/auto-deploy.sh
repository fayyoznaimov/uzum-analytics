#!/usr/bin/env bash
# Автодеплой с GitHub на сервере ParisaUbuntu. Запускается через юнит
# uzum-deploy.service (systemd --user): сразу после push — из GitHub Actions
# (self-hosted runner, .github/workflows/deploy.yml), и запасным таймером
# uzum-deploy.timer раз в 5 минут, если runner недоступен.
#
# Если в origin/main появились новые коммиты:
#   pull (только fast-forward) → npm install (если менялись зависимости) →
#   prisma generate → тесты → проверка типов → сборка → prisma db push →
#   перезапуск uzum-api/uzum-web → проверка /api/health и веба.
# Любой шаг упал — откат на прежний коммит, пересборка, перезапуск и сообщение
# в Telegram. Коммит, на котором деплой упал, повторно не пробуется: нужен новый push.
#
# db push запускается без --accept-data-loss: изменение схемы, которое удаляет
# данные, остановит деплой, а не выполнится молча.
#
# Рабочую копию на сервере руками не правим: при локальных изменениях деплой
# останавливается и пишет в Telegram.
#
# Ручной запуск:  bash ~/uzum/scripts/auto-deploy.sh
# Лог:            ~/.local/state/uzum-deploy/deploy.log

set -uo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-main}"
STATE="$HOME/.local/state/uzum-deploy"
LOG="$STATE/deploy.log"
mkdir -p "$STATE"

exec 9>"$STATE/lock"
flock -n 9 || exit 0

cd "$APP"
set -a; . "$APP/.env"; set +a
export NEXT_TELEMETRY_DISABLED=1

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
notify() { log "telegram: $1"; timeout 60 npx --no-install tsx apps/api/scripts/notify-telegram.ts "$1" >>"$LOG" 2>&1 || true; }
step() {
  local name="$1"; shift
  log "→ $name"
  if "$@" >>"$LOG" 2>&1; then return 0; fi
  log "✗ $name"
  FAILED_STEP="$name"
  return 1
}

health() {
  local api="http://127.0.0.1:${API_PORT:-4000}/api/health" web="http://127.0.0.1:${WEB_PORT:-${PORT:-3200}}/"
  for _ in $(seq 1 30); do
    if curl -fs -o /dev/null -m 5 "$api" && curl -s -o /dev/null -m 5 -w '%{http_code}' "$web" | grep -qE '^(2|3)'; then return 0; fi
    sleep 2
  done
  return 1
}

# $1 — коммит, от которого идём: по нему решаем, нужен ли npm install.
build_and_restart() {
  local from="$1"
  if [ -n "$(git diff --name-only "$from" HEAD -- package.json package-lock.json apps/api/package.json apps/web/package.json)" ]; then
    step "npm install" npm install --workspaces --include-workspace-root --include=dev --legacy-peer-deps --no-audit --no-fund || return 1
  fi
  step "prisma generate" npm run db:generate &&
  step "тесты" npm test &&
  step "проверка типов API" npm run test:types:api &&
  step "сборка" npm run build &&
  step "схема БД" npx prisma db push --schema apps/api/prisma/schema.prisma --skip-generate &&
  step "перезапуск сервисов" systemctl --user restart uzum-api.service uzum-web.service &&
  step "health-check" health
}

if ! git fetch --quiet origin "$BRANCH" >>"$LOG" 2>&1; then
  # Сеть мигает — не спамим в Telegram каждую минуту, только в лог.
  log "git fetch не удался"
  exit 1
fi

PREV="$(git rev-parse HEAD)"
NEXT="$(git rev-parse "origin/$BRANCH")"
[ "$PREV" = "$NEXT" ] && exit 0
[ "$(cat "$STATE/failed" 2>/dev/null)" = "$NEXT" ] && exit 0

SUBJECT="$(git log -1 --format=%s "$NEXT")"
SHORT="$(git rev-parse --short "$NEXT")"
log "=== деплой $SHORT: $SUBJECT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "$NEXT" >"$STATE/failed"
  notify "⚠️ Uzum Analytics: деплой $SHORT не выполнен — на сервере есть локальные изменения в рабочей копии. Их нужно закоммитить через GitHub или убрать (git status в ~/uzum)."
  exit 1
fi

if ! git merge --ff-only --quiet "origin/$BRANCH" >>"$LOG" 2>&1; then
  echo "$NEXT" >"$STATE/failed"
  notify "⚠️ Uzum Analytics: деплой $SHORT не выполнен — история на сервере разошлась с GitHub (fast-forward невозможен)."
  exit 1
fi

FAILED_STEP=""
if build_and_restart "$PREV"; then
  rm -f "$STATE/failed"
  log "✓ деплой $SHORT готов"
  notify "✅ Uzum Analytics обновлён: $SHORT — $SUBJECT"
  exit 0
fi

BROKEN_STEP="$FAILED_STEP"
echo "$NEXT" >"$STATE/failed"
log "откат на $(git rev-parse --short "$PREV")"
git reset --hard --quiet "$PREV"
if build_and_restart "$NEXT"; then
  notify "⚠️ Uzum Analytics: деплой $SHORT ($SUBJECT) упал на шаге «$BROKEN_STEP». Откатился на $(git rev-parse --short "$PREV"), сервис работает. Подробности: ~/.local/state/uzum-deploy/deploy.log"
else
  notify "🚨 Uzum Analytics: деплой $SHORT упал на шаге «$BROKEN_STEP», и откат тоже не прошёл (шаг «$FAILED_STEP»). Сервис может не работать — нужна ручная проверка. Лог: ~/.local/state/uzum-deploy/deploy.log"
fi
exit 1
