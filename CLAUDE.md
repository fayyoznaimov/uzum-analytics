# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Uzum Analytics — a self-hosted seller analytics cabinet for the Uzum marketplace: sales, profit, cost price, warehouse, supplies, goals, Telegram notifications, and a "wallet" that forecasts when money lands in the Uzum withdrawal basket. npm-workspaces monorepo: `apps/api` (NestJS 11) + `apps/web` (Next.js 15 App Router, React 19), Postgres via Prisma, deployed with Docker Compose. Product, UI, docs, commits, and all user-facing strings are in **Russian** — keep new strings Russian.

## Commands

Run from the repo root unless noted. npm is required (`.npmrc` sets `legacy-peer-deps=true`).

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Dev (api + web together) | `npm run dev` — needs Postgres running and a valid `.env` |
| Unit tests (API only) | `npm test` → `vitest run` in `apps/api` |
| Single test file / name | `npm run test -w apps/api -- src/common/__tests__/finance.spec.ts` or `... -- -t "substring of test name"` |
| Watch tests | `npm run test:watch -w apps/api` |
| API type gate (CI) | `npm run test:types:api` — see note below |
| Lint | `npm run lint` — **this is `tsc --noEmit`**, there is no ESLint/Prettier |
| Web build check | `npm run test:web` |
| Everything | `npm run test:all` (test + test:types:api + test:web) or `npm run check` (test + lint + build) |
| Prisma client | `npm run db:generate` |
| Prisma migrate (local) | `npm run db:migrate` |
| Seed admin/data | `npm run db:seed` |
| Docker (prod-like) | `docker compose up -d --build` |
| First-time server bootstrap | `./setup.sh` (interactive, writes `.env`, refuses to re-run) |
| Smoke test | `./scripts/smoke-test.sh` (add `SMOKE_TEST_UZUM=1 SMOKE_TEST_TELEGRAM=1` for live integration checks) |

`test:types:api` compiles `apps/api` against a **hand-written Prisma client stub** (`apps/api/audit/prisma-client-stub.ts`, wired via `tsconfig.audit.json` path mapping) so type-checking passes without a real `prisma generate`. If you change how Prisma models/enums are used in a way the stub doesn't cover, update the stub.

Tests: Vitest with no config file — any `*.spec.ts` under `apps/api` is picked up; they live in `__tests__/` folders beside the code they cover and almost all target the pure modules in `apps/api/src/common/`.

## Architecture

### API (`apps/api`)
- **No per-feature Nest modules.** A single `AppModule` (`src/app.module.ts`) registers every controller and provider flat. A feature = a folder `src/modules/<feature>/` with `<feature>.controller.ts` + `<feature>.service.ts`. When adding a feature, wire both arrays in `app.module.ts`.
- **Business logic is extracted into pure functions in `src/common/`** (`finance.ts`, `payout-basket.ts`, `payout-forecast.ts`, `order-state.ts`, `advertising.ts`, `inventory-report.ts`, `inventory-analytics.ts`, `sku-payout.ts`, `profit-days.ts`, `financial-statement.ts`, `fbo-supply-summary.ts`, `period.ts`). Services orchestrate Prisma + these functions; put testable logic here, not in services.
- Shared providers: `PrismaService`, `CryptoService`, `TelegramClient`.
- `main.ts`: global prefix `/api`, `helmet`, CORS restricted to `WEB_ORIGIN` (comma-separated) plus any `chrome-extension://` origin, global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted` + `transform`), env validation at boot (`DATABASE_URL`, `JWT_SECRET` ≥ 32 chars, `APP_ENCRYPTION_KEY`).
- **Auth**: JWT bearer, 12h expiry. `AuthGuard` is applied **per controller/route** with `@UseGuards(AuthGuard)`, not globally — new endpoints are public unless guarded. `ThrottlerGuard` is the one global guard. A single admin user is seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- **Integration credentials** (`UZUM`, `UZUM_INTERNAL`, `OPENAI`, `TELEGRAM`) are stored in the DB (`IntegrationCredential`), **encrypted at rest** with AES-256-GCM by `CryptoService` using `APP_ENCRYPTION_KEY` (base64, decodes to exactly 32 bytes). They are configured through the Settings UI at runtime, not via env.
- **Sync** (`SyncService`): `@Cron` jobs (schedules from env: `SYNC_CRON`, `ORDER_NOTIFY_CRON`, `SUPPLY_SYNC_CRON`, `SLOT_WATCH_CRON`, `AD_RATE_DIGEST_CRON`, …) pull from the Uzum Seller OpenAPI base `https://api-seller.uzum.uz/api/seller-openapi` (`/v1/shops`, `/v1/product/shop/:id`, `/v1/finance/orders`, `/v1/finance/expenses`). Manual run: `POST /api/sync/run`; poll `GET /api/sync/runs`. Sync is defensive: unrecognized payload shapes throw rather than wiping stored data; pagination has hard page caps.

### Core domain invariants — do not "improve" these casually
- **Money timeline**: `dateIssued` (actual handover to buyer) → 10 full calendar hold days → next day the amount becomes `basketEligibleAt` (enters the withdrawal basket) → then paid out on the shop's payout schedule. A return *after* issue writes a negative `OrderFinancialEvent` that reduces basket / payout / profit / cashflow forecasts. Reference: `docs/UZUM_WALLET_BASKET.md`, `common/payout-basket.ts`, `common/payout-forecast.ts`.
- **Advertising spend for actuals is never modeled or averaged.** It is rebuilt solely from real Uzum expense-ledger rows — code `У000120` (per-order boost), `У000119` (top/campaign boost). Where the fact isn't published yet, the UI may show an estimate from the last *observed* per-product rate, always explicitly labeled as an estimate. `common/advertising.ts`.
- **All day/hour bucketing is `Asia/Tashkent`.** Use the `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' })` helpers in `common/period.ts` (API) / `web/lib/period.ts` (client). Don't add raw `new Date()` local-time date arithmetic. API list endpoints take `from` / `to` / `days` / `compare` query params resolved by `resolvePeriod`.
- Profit/margin figures are shown only when every input (payout, cost price, ad fact/coverage) is known; otherwise the code deliberately renders "не рассчитана" rather than a guess. Preserve that "known vs. estimated" distinction in any financial output, including Telegram messages.

### Web (`apps/web`)
- Next.js App Router. **Every `app/<route>/page.tsx` is a one-line re-export** of `components/<Name>Client.tsx`. All real UI lives in the `*Client.tsx` client components; keep it that way.
- `lib/api.ts`: `api()` fetch wrapper — JWT from `localStorage['ua_token']`, auto-`logout()` on 401, `NEXT_PUBLIC_API_URL` base (`/api` in prod). `money()` / `compact()` are ru-RU formatters. `syncAndWait()` triggers + polls a sync.
- `lib/period.ts`: `useAnalyticsPeriod()` hook — selected period persisted to `localStorage` and broadcast across components via a custom window event.
- Styling is **hand-written class-based CSS** in `app/globals.css` (+ `costs-ui.css`, `reviews-ui.css`), no Tailwind, no CSS modules. Charts: `recharts`. Icons: `lucide-react`.
- Web components are written in an intentionally dense, single-line style. Match the surrounding file rather than reformatting.
- `next.config.ts` rewrites `/api/:path*` → `API_INTERNAL_URL` (`http://api:4000` in Docker); `output: 'standalone'` unless `NEXT_OUTPUT_STANDALONE=false`.

### Browser extension (`extensions/uzum-campaign-audit/`)
MV3 Chrome extension that scrapes visible ad-campaign search-term stats on `seller.uzum.uz` and POSTs them to the local API. Flow: `POST /api/ad-audit/pairing-code` (auth'd, from the app) → extension calls `POST /api/ad-audit/pair` with the code → then `POST /api/ad-audit/ingest` / `/export` with an `x-ad-audit-token` header. Consumed by the Ads screen via `GET /api/ad-audit/latest`.

## Workflow
- Development happens in the local clone on the owner's Windows PC. **After each finished task** (not after every file save): run `npm test` and `npm run test:types:api` (plus `npm run test:web` if `apps/web` changed), then commit with a Russian message and `git push` to `main` without asking — the owner wants every finished change in Git right away. A push to `main` deploys to production within seconds, so never push failing checks or half-done work; say so if a check fails instead of pushing.
- Commands that need the production DB or Uzum/Telegram tokens (`apps/api/scripts/*.ts`, sync, price changes) only work on the server; `.env` and the DB are not in Git.

## Deploy notes
- **Production = ParisaUbuntu (172.0.30.4), rootless, no Docker**: `systemd --user` services `uzum-postgres`, `uzum-api` (port 4100), `uzum-web` (port 3200) in `~/uzum`. Code flows through GitHub `main`: on push, a self-hosted GitHub Actions runner on the server (`.github/workflows/deploy.yml`, label `uzum-server`, unit `github-runner`) starts `uzum-deploy.service` → `scripts/auto-deploy.sh`; `uzum-deploy.timer` re-checks every 5 min as a fallback — ff-only pull → tests → type gate → build → `prisma db push` (no `--accept-data-loss`) → restart → health check, with automatic rollback and a Telegram message on failure. Log: `~/.local/state/uzum-deploy/deploy.log`. Don't edit the server's working copy directly — a dirty tree blocks deploys; commit and push instead.
- Price changes: `PricingService.sendPrice` / `apps/api/scripts/send-price.ts` (dry-run by default, every attempt logged in `PriceChange`). Uzum rejects `sendPriceData` with `sku-price-001` while a SKU is in an Uzum promo; promo prices are only editable in the seller cabinet, and the OpenAPI `price` field is the promo price during a promo, not the base price.
- Docker runtime applies the schema with `prisma db push` (not migrations) and runs `prisma/seed.cjs` on every start; ports `3000` (web) and `4000` (api) are bound to `127.0.0.1` and expected to sit behind a reverse proxy (`docker-compose.traefik.example.yml`).
- Prefer a short project path without OneDrive on Windows; Docker base image is pinned to Node 20 to dodge an `npm ci` hang seen on Docker Desktop/Windows.
- Money-affecting changes must be verified on the server with a live smoke test and a manual reconciliation of 10–20 rows against the real Uzum cabinet (`SERVER_CHECKLIST.md`, `PROJECT_STATUS.md`).
