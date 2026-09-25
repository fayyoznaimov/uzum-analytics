# Server checklist v1.0

## 1. Распаковка

```bash
unzip uzum-analytics-v1.0-full.zip
cd uzum-analytics-v1.0
chmod +x setup.sh scripts/*.sh
./setup.sh
```

## 2. Проверка сборки

```bash
npm ci
npm run prisma:generate -w apps/api
npm run test -w apps/api
npm run test:types:api
npm run lint -w apps/web
npm run build -w apps/web
```

## 3. Запуск

```bash
docker compose up -d --build
```

## 4. Проверка интеграций

```bash
./scripts/smoke-test.sh
SMOKE_TEST_UZUM=1 SMOKE_TEST_TELEGRAM=1 ./scripts/smoke-test.sh
```

## 5. Ручная сверка денег

- Открыть Uzum Finance.
- Взять 10–20 строк с `dateIssued`.
- Проверить дату корзины вывода.
- Проверить возвраты после выдачи.
- Проверить, что комиссия и логистика Uzum не вычитаются второй раз после суммы к выплате.

## 6. Домен

Рекомендовано:

```text
analytics.parisahome.com
analytics.parisahome.com/api
```

DNS: A-запись `analytics` на IP VPS.
