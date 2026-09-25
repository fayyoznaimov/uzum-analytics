#!/usr/bin/env sh
set -eu

if ! command -v docker >/dev/null 2>&1; then echo "Docker не найден. Установите Docker Engine и Compose plugin."; exit 1; fi
if ! docker compose version >/dev/null 2>&1; then echo "Docker Compose plugin не найден."; exit 1; fi
if ! command -v openssl >/dev/null 2>&1; then echo "openssl не найден. Установите пакет openssl."; exit 1; fi
if [ -f .env ]; then echo ".env уже существует. Для обновления не запускайте setup.sh повторно; используйте docker compose up -d --build."; exit 1; fi

printf "Email администратора [admin@example.com]: "
read ADMIN_EMAIL_INPUT
ADMIN_EMAIL_INPUT=${ADMIN_EMAIL_INPUT:-admin@example.com}
printf "Пароль администратора (минимум 12 символов): "
read -r ADMIN_PASSWORD_INPUT
if [ ${#ADMIN_PASSWORD_INPUT} -lt 12 ]; then echo "Пароль слишком короткий."; exit 1; fi
printf "Shop ID: "
read SHOP_ID_INPUT
if [ -z "$SHOP_ID_INPUT" ]; then echo "Shop ID обязателен."; exit 1; fi
printf "Название магазина [Uzum shop $SHOP_ID_INPUT]: "
read SHOP_NAME_INPUT
SHOP_NAME_INPUT=${SHOP_NAME_INPUT:-Uzum shop $SHOP_ID_INPUT}
printf "Адрес сайта [http://localhost:3000]: "
read WEB_URL_INPUT
WEB_URL_INPUT=${WEB_URL_INPUT:-http://localhost:3000}

DB_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 48)
APP_KEY=$(openssl rand -base64 32 | tr -d '\n')

cat > .env <<ENV
POSTGRES_DB=uzum_analytics
POSTGRES_USER=uzum
POSTGRES_PASSWORD=$DB_PASSWORD
DATABASE_URL=postgresql://uzum:$DB_PASSWORD@postgres:5432/uzum_analytics?schema=public
API_PORT=4000
JWT_SECRET=$JWT_SECRET
APP_ENCRYPTION_KEY=$APP_KEY
ADMIN_EMAIL=$ADMIN_EMAIL_INPUT
ADMIN_PASSWORD=$ADMIN_PASSWORD_INPUT
RESET_ADMIN_PASSWORD=false
SEED_DEMO_DATA=false
DEFAULT_SHOP_ID=$SHOP_ID_INPUT
DEFAULT_SHOP_NAME=$SHOP_NAME_INPUT
WEB_ORIGIN=$WEB_URL_INPUT
NEXT_PUBLIC_API_URL=/api
SYNC_CRON=*/15 * * * *
SUPPLY_SYNC_CRON=*/10 * * * *
SLOT_WATCH_CRON=*/5 * * * *
ORDER_SYNC_MAX_PAGES=200
PRODUCT_SYNC_MAX_PAGES=100
LOW_STOCK_THRESHOLD=10
ENV
chmod 600 .env

./scripts/preflight.sh --config-only
echo "Собираю и запускаю контейнеры…"
docker compose up -d --build
./scripts/smoke-test.sh

echo ""
echo "Готово: $WEB_URL_INPUT"
echo "Uzum и Telegram токены добавьте в разделе Настройки. Кнопка Telegram «Отправить тест» должна доставить реальное сообщение."
