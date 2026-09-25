#!/usr/bin/env sh
set -eu

[ -f .env ] || { echo "[FAIL] .env не найден" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${POSTGRES_USER:?POSTGRES_USER пуст}"
: "${POSTGRES_DB:?POSTGRES_DB пуст}"

mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
TARGET="backups/uzum-analytics-$STAMP.dump"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$TARGET"
[ -s "$TARGET" ] || { rm -f "$TARGET"; echo "[FAIL] Резервная копия пустая" >&2; exit 1; }
echo "[OK] Создано: $TARGET"
