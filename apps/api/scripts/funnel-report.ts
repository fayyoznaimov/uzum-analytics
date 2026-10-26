/**
 * Отчёт «Воронка»: показы → открытия → корзина → заказ → выкуп по магазину, товарам, цветам и SKU.
 *
 *   npx tsx apps/api/scripts/funnel-report.ts                         текст в консоль, 28 дней
 *   ... --days 14                                                     период (7–56 дней, целыми неделями)
 *   ... --out /tmp/voronka.html --json /tmp/voronka.json              ещё и HTML-отчёт / JSON на диск
 *   ... --telegram                                                    отправить HTML-отчёт файлом в Telegram владельца
 *   ... --quiet                                                       не печатать цифры (для логов GitHub Actions:
 *                                                                     репозиторий публичный, логи видят все)
 *
 * Только чтение: аналитика кабинета Uzum (Cube) и список товаров кабинета с токеном UZUM_INTERNAL из БД,
 * плюс SKU из БД. В кабинете ничего не меняется, токены нигде не печатаются. Логика — common/funnel-report.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { IntegrationType } from '@prisma/client';
import { isCubeContinueWait, shortCubeError } from '../src/common/ad-agent';
import { tashkentDay } from '../src/common/auto-pricing';
import { CryptoService } from '../src/common/crypto.service';
import {
  buildFunnelReport,
  cleanSkuTitle,
  FUNNEL_REPORT_ROW_LIMIT,
  funnelSkuUrl,
  funnelWindow,
  parseFunnelRows,
  renderFunnelHtml,
  renderFunnelText,
  skuColor,
  type SkuInfo,
} from '../src/common/funnel-report';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

const CABINET = 'https://api-seller.uzum.uz/api/seller';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);

function save(path: string | undefined, content: string, label: string) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`${label}: ${path}`);
}

async function main() {
  const prisma = new PrismaService();
  const crypto = new CryptoService();
  const getPlain = async (type: IntegrationType) => {
    const row = await prisma.integrationCredential.findUnique({ where: { type } });
    if (!row || !row.enabled) return null;
    const token = crypto.decrypt(row);
    return token ? { token, metadata: (row.metadata || {}) as any, row } : null;
  };
  // Сам отчёт отправляет только файл (флаг --telegram); служебные уведомления сервисов выключены.
  const integrations = { getPlain, notifyTelegram: async () => false } as unknown as IntegrationsService;
  const cabinet = new PromoPricingService(prisma, integrations, new PricingService(prisma, integrations));
  const quiet = flag('--quiet');
  try {
    const today = tashkentDay(new Date());
    const rawDays = Number(arg('--days'));
    const window = funnelWindow(today, Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 28);

    // Воронка по SKU и дням. Куб SellerReportProductFunnelSku пропал из аналитики Uzum 09–14.10.2026 —
    // тогда понятная ошибка вместо HTTP 400 с огромным URL запроса.
    let body: any = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      body = (await cabinet.cabinet('GET', funnelSkuUrl(window.from, window.to)).catch((error: any) => {
        const message = String(error?.message || error);
        if (/not found/i.test(message)) throw new Error('Воронка недоступна: Uzum убрал куб SellerReportProductFunnelSku из аналитики (09–14.10.2026) — показов, открытий и корзины там больше нет. Заказы и выкупы по товарам — в отчёте агента рекламы.');
        throw new Error(shortCubeError(message));
      })).body;
      if (!isCubeContinueWait(body)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (isCubeContinueWait(body)) throw new Error('Cube не посчитал воронку за 40 секунд — запустите ещё раз');
    const rawRows: unknown[] = body?.results?.[0]?.data ?? body?.data ?? [];
    const rows = parseFunnelRows(body);

    // Названия, остатки и характеристики SKU из кабинета (как у рекламного бота): в БД цвет обычно пустой.
    const shopId = await cabinet.cabinetShopId();
    const cabinetSkus = new Map<string, { productId: string; productTitle: string; title: string; stock: number | null; characteristics: unknown }>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const productsBody = (await cabinet.cabinet('GET', `${CABINET}/shop/${shopId}/product/getProducts`, { page, size: PAGE_SIZE })).body;
      const productList: any[] = Array.isArray(productsBody?.productList) ? productsBody.productList : [];
      for (const product of productList) {
        for (const sku of Array.isArray(product?.skuList) ? product.skuList : []) {
          const stock = Number(sku?.quantityActive);
          cabinetSkus.set(String(sku?.skuId), {
            productId: String(product?.productId ?? ''),
            productTitle: String(product?.title ?? '').replace(/\s+/g, ' ').trim(),
            title: cleanSkuTitle(sku?.skuTitle ?? sku?.skuFullTitle),
            stock: Number.isFinite(stock) ? stock : null,
            characteristics: sku?.characteristicsList ?? sku?.characteristics,
          });
        }
      }
      if (productList.length < PAGE_SIZE) break;
    }

    const shop = await prisma.shop.findFirst({ where: { isActive: true } });
    const dbSkus = shop
      ? await prisma.sku.findMany({
          where: { product: { shopId: shop.id } },
          select: { externalId: true, sellerSku: true, color: true, size: true, stock: true, product: { select: { externalId: true, title: true } } },
        })
      : [];
    const skus = new Map<string, SkuInfo>();
    for (const sku of dbSkus) {
      const id = String(sku.externalId);
      const live = cabinetSkus.get(id);
      skus.set(id, {
        skuId: id,
        productId: String(sku.product.externalId),
        productTitle: live?.productTitle || String(sku.product.title ?? '').replace(/\s+/g, ' ').trim(),
        color: skuColor({ color: sku.color, characteristics: live?.characteristics, titles: [live?.title, sku.sellerSku] }),
        size: sku.size ?? null,
        stock: live?.stock ?? (Number.isFinite(Number(sku.stock)) ? Number(sku.stock) : null),
        title: live?.title || cleanSkuTitle(sku.sellerSku) || null,
      });
    }
    for (const [id, live] of cabinetSkus) {
      if (skus.has(id)) continue;
      skus.set(id, { skuId: id, productId: live.productId, productTitle: live.productTitle, color: skuColor({ characteristics: live.characteristics, titles: [live.title] }), size: null, stock: live.stock, title: live.title || null });
    }

    const report = buildFunnelReport({ rows, skus: [...skus.values()], today, from: window.from, to: window.to, truncated: rawRows.length >= FUNNEL_REPORT_ROW_LIMIT });
    const html = renderFunnelHtml(report);

    if (quiet) {
      console.log(`Воронка ${report.from} … ${report.to}: ${report.products.length} товаров, ${skus.size} SKU. Цифры в лог не выводятся.`);
      for (const warning of report.warnings) console.log(`ВНИМАНИЕ: ${warning}`);
    } else {
      console.log(renderFunnelText(report).join('\n'));
    }
    save(arg('--out'), html, 'HTML-отчёт');
    save(arg('--json'), JSON.stringify(report, null, 2), 'JSON');

    if (flag('--telegram')) {
      const telegram = await getPlain(IntegrationType.TELEGRAM);
      const chatId = String(telegram?.metadata?.chatId || '');
      if (!telegram?.token || !chatId) throw new Error('Telegram не настроен: нет токена бота или chatId в настройках');
      const shopCounts = report.shop.counts;
      const caption = [
        `Воронка ${report.from} … ${report.to} (${report.days} дн.)`,
        `Показы ${shopCounts.impressions.toLocaleString('ru-RU')} → открытия ${shopCounts.views.toLocaleString('ru-RU')} → корзина ${shopCounts.atc.toLocaleString('ru-RU')} → заказы ${shopCounts.ordered.toLocaleString('ru-RU')} → выкуп ${shopCounts.sold.toLocaleString('ru-RU')}`,
        ...report.warnings,
        'Откройте файл в браузере.',
      ].join('\n');
      await new TelegramClient().sendDocument(telegram.token, chatId, Buffer.from(html, 'utf8'), `voronka_${report.from}_${report.to}.html`, caption.slice(0, 1000));
      console.log('HTML-отчёт отправлен в Telegram.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
