#!/usr/bin/env bash
# Разворачивает Uzum Analytics на ParisaUbuntu (172.0.30.4) без Docker и без root.
#
# Почему так: докера на сервере нет, а ставить его на машину, где живёт
# продакшн-агент по 1С, — лишний риск. Всё кладётся в домашнюю папку
# пользователя parisahome, системные каталоги не трогаются. Автозапуск —
# через systemd --user; для пользователя уже включён linger, поэтому сервисы
# переживают перезагрузку.
#
# Запускать НА СЕРВЕРЕ:
#   bash ~/uzum/scripts/deploy-rootless.sh
#
# Перед этим на рабочей машине один раз залить код и дамп:
#   cd "<папка проекта>"
#   tar czf /tmp/uzum-src.tar.gz --exclude=node_modules --exclude=.next \
#       --exclude=dist --exclude=backups --exclude=.git .
#   scp /tmp/uzum-src.tar.gz backups/uzum-full-2026-09-07.sql parisahome@172.0.30.4:/tmp/
#   ssh parisahome@172.0.30.4 'mkdir -p ~/uzum && tar xzf /tmp/uzum-src.tar.gz -C ~/uzum'
#
# Скрипт идемпотентный: повторный запуск ничего не ломает.

set -euo pipefail

APP="$HOME/uzum"
PGROOT="$HOME/pgsql"
PGBIN="$PGROOT/node_modules/@embedded-postgres/linux-x64/native/bin"
PGDATA="$PGROOT/data"
PGPORT=55433
PGUSER_APP=uzum
PGDB=uzum_analytics
DUMP="${DUMP:-/tmp/uzum-full-2026-09-07.sql}"
API_PORT=4100
WEB_PORT=3200

say() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------- 1. Node 20
say "Node 20"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use 20 >/dev/null
node -v

# ------------------------------------------------------------- 2. Postgres up
say "Postgres"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "Кластер не инициализирован — сначала выполните шаги установки Postgres." >&2
  exit 1
fi
"$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGROOT/postgres.log" -w start >/dev/null 2>&1 || true
ss -tln | grep -q ":$PGPORT" && echo "слушает 127.0.0.1:$PGPORT"

# ----------------------------------------------- 3. Клиент psql (нужен разово)
# В пакете embedded-postgres есть только сервер. Клиент ставим одним из двух
# способов — что доступно, то и сработает.
if ! command -v psql >/dev/null && [ ! -x "$PGROOT/client/root/usr/lib/postgresql/17/bin/psql" ]; then
  say "Клиент psql"
  if sudo -n true 2>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client
  else
    echo "Нет sudo. Выполните вручную ОДИН раз:"
    echo "  sudo apt-get install -y postgresql-client"
    echo "и запустите скрипт снова."
    exit 1
  fi
fi
PSQL="$(command -v psql || echo "$PGROOT/client/root/usr/lib/postgresql/17/bin/psql")"
export PGPASSWORD="$(cat "$PGROOT/.superpass")"
PSQL_ARGS=(-h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_APP")

# ------------------------------------------------------------- 4. База данных
say "База $PGDB"
if ! "$PSQL" "${PSQL_ARGS[@]}" -d postgres -tAc "select 1 from pg_database where datname='$PGDB';" | grep -q 1; then
  "$PSQL" "${PSQL_ARGS[@]}" -d postgres -c "create database $PGDB;"
  echo "создана"
else
  echo "уже есть"
fi

# --------------------------------------------------- 5. Восстановление данных
# Только если база пустая — повторный запуск не затирает рабочие данные.
TABLES=$("$PSQL" "${PSQL_ARGS[@]}" -d "$PGDB" -tAc \
  "select count(*) from information_schema.tables where table_schema='public';")
if [ "$TABLES" -eq 0 ]; then
  say "Восстановление дампа"
  [ -f "$DUMP" ] || { echo "Не найден дамп: $DUMP" >&2; exit 1; }
  "$PSQL" "${PSQL_ARGS[@]}" -d "$PGDB" -v ON_ERROR_STOP=0 -f "$DUMP" >/dev/null
  echo "залито"

  say "Чистка: LinenSaF и остатки аудита РК"
  # Каскад по shopId снимет товары, SKU, заказы, позиции, расходы и поставки.
  "$PSQL" "${PSQL_ARGS[@]}" -d "$PGDB" -c 'delete from "Shop" where name = '"'"'LinenSaF'"'"';'
  "$PSQL" "${PSQL_ARGS[@]}" -d "$PGDB" -c 'drop table if exists "AdCampaignAudit", "AdExtensionClient", "AdPairingCode" cascade;'
else
  say "В базе уже $TABLES таблиц — восстановление пропущено"
fi

# ------------------------------------------------------------------ 6. .env
say "Конфигурация"
if [ ! -f "$APP/.env" ]; then
  # Ключи генерируются здесь и на рабочей машине не светятся.
  JWT=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
  ENC=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  cat > "$APP/.env" <<EOF
DATABASE_URL="postgresql://$PGUSER_APP:$(cat "$PGROOT/.superpass")@127.0.0.1:$PGPORT/$PGDB?schema=public"
JWT_SECRET="$JWT"
APP_ENCRYPTION_KEY="$ENC"
WEB_ORIGIN="http://172.0.30.4:$WEB_PORT"
NEXT_PUBLIC_API_URL="http://172.0.30.4:$API_PORT/api"
API_INTERNAL_URL="http://127.0.0.1:$API_PORT"
PORT=$API_PORT
ADMIN_EMAIL="fayyoznaimov@gmail.com"
ADMIN_PASSWORD="смените-после-первого-входа"
UZUM_SHOP_ID="92776"
APP_TIMEZONE="Asia/Tashkent"
PAYOUT_BASKET_HOLD_DAYS=10
DEFAULT_TAX_PERCENT=1
DEFAULT_AD_PERCENT=0
SYNC_CRON="*/30 * * * *"
ORDER_NOTIFY_CRON="*/5 * * * *"
EOF
  chmod 600 "$APP/.env"
  echo "создан $APP/.env — токены Uzum и Telegram вносятся через UI в Настройках"
else
  echo "уже есть, не трогаю"
fi

# ------------------------------------------------------------- 7. Сборка
say "Сборка"
cd "$APP"
npm install --workspaces --include-workspace-root --include=dev --legacy-peer-deps --no-audit --no-fund
npm run prisma:generate -w apps/api
npm run build -w apps/api
npm run build -w apps/web

# Схему подтягиваем к коду. db push здесь безопасен: таблицы Ad* уже удалены выше,
# так что сносить ему нечего.
set -a; . "$APP/.env"; set +a
npx prisma db push --schema apps/api/prisma/schema.prisma --skip-generate
node apps/api/prisma/seed.cjs || true

# ------------------------------------------------- 8. systemd --user сервисы
say "Автозапуск"
mkdir -p "$HOME/.config/systemd/user"
NODE_BIN="$(dirname "$(command -v node)")"

cat > "$HOME/.config/systemd/user/uzum-api.service" <<EOF
[Unit]
Description=Uzum Analytics API
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
Environment=NODE_ENV=production
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN/node $APP/apps/api/dist/src/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat > "$HOME/.config/systemd/user/uzum-web.service" <<EOF
[Unit]
Description=Uzum Analytics Web
After=uzum-api.service

[Service]
Type=simple
WorkingDirectory=$APP/apps/web
EnvironmentFile=$APP/.env
Environment=NODE_ENV=production
Environment=PORT=$WEB_PORT
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Postgres тоже под systemd, иначе после перезагрузки база не поднимется.
cat > "$HOME/.config/systemd/user/uzum-postgres.service" <<EOF
[Unit]
Description=Uzum Analytics PostgreSQL (rootless)
Before=uzum-api.service

[Service]
Type=forking
ExecStart=$PGBIN/pg_ctl -D $PGDATA -l $PGROOT/postgres.log -w start
ExecStop=$PGBIN/pg_ctl -D $PGDATA -m fast -w stop
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now uzum-postgres.service uzum-api.service uzum-web.service

# ------------------------------------------------------------- 9. Проверка
say "Проверка"
sleep 8
for s in uzum-postgres uzum-api uzum-web; do
  printf '%-16s %s\n' "$s" "$(systemctl --user is-active $s.service)"
done
curl -s -o /dev/null -w "API  /api/health  HTTP %{http_code}  %{time_total}s\n" -m 30 "http://127.0.0.1:$API_PORT/api/health" || true
curl -s -o /dev/null -w "WEB  /           HTTP %{http_code}  %{time_total}s\n" -m 30 "http://127.0.0.1:$WEB_PORT/" || true

say "Готово"
echo "Веб:  http://172.0.30.4:$WEB_PORT"
echo "API:  http://172.0.30.4:$API_PORT/api"
echo
echo "Дальше вручную:"
echo "  1. Войти под $(grep ADMIN_EMAIL "$APP/.env" | cut -d'\"' -f2) и сменить пароль."
echo "  2. В Настройках заново вписать токен Uzum и Telegram — они зашифрованы"
echo "     старым ключом и на новом сервере не расшифруются."
echo "  3. Запустить синхронизацию и сверить 10-20 строк с кабинетом Uzum."
