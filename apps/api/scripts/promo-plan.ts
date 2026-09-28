/**
 * План цен для участия в акции Uzum — только рекомендации, ничего не меняет:
 *
 *   npx tsx apps/api/scripts/promo-plan.ts              все SKU магазина
 *   ... --sale 394                                     только товары, подходящие для акции 394 (из кабинета)
 *
 * Правила — в src/common/promo-plan.ts: якорь — цена, по которой SKU реально выкупали за 28 (90) дней,
 * мало остатка — минимальная скидка, нет продаж — ниже якоря, поток — чуть выше; потолок — базовая −1%,
 * пол — маржа 15%. Данные те же, что у автоцен (AutoPricingService.collect).
 * Токены берутся из БД (IntegrationCredential) и нигде не печатаются.
 */
import { IntegrationType } from '@prisma/client';
import { tashkentDay } from '../src/common/auto-pricing';
import { CryptoService } from '../src/common/crypto.service';
import { OpenclawClient } from '../src/common/openclaw.client';
import { PrismaService } from '../src/common/prisma.service';
import { formatPromoPlan, planPromoPrices, PROMO_PLAN_DEFAULTS } from '../src/common/promo-plan';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { AutoPricingService } from '../src/modules/pricing/auto-pricing.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const saleId = arg('sale');
  if (saleId !== undefined && !/^\d+$/.test(saleId)) throw new Error('--sale: номер акции');
  const prisma = new PrismaService();
  const crypto = new CryptoService();
  const integrations = {
    async getPlain(type: IntegrationType) {
      const row = await prisma.integrationCredential.findUnique({ where: { type } });
      if (!row || !row.enabled) return null;
      const token = crypto.decrypt(row);
      return token ? { token, metadata: (row.metadata || {}) as any, row } : null;
    },
  } as unknown as IntegrationsService;
  const pricing = new PricingService(prisma, integrations);
  const promo = new PromoPricingService(prisma, integrations, pricing);
  const service = new AutoPricingService(prisma, integrations, pricing, promo, new OpenclawClient());
  try {
    const now = new Date();
    const today = tashkentDay(now);
    const { inputs, notes } = await service.collect(now, today);

    let suitable: Set<string> | null = null;
    if (saleId) {
      try {
        const shopId = await promo.cabinetShopId();
        const sale = (await promo.cabinet('GET', `/shop/${shopId}/marketing/sales/${saleId}`)).body?.payload;
        const list = (await promo.cabinet('GET', `/shop/${shopId}/marketing/sales/${saleId}/suitable-products`, { page: 0, size: 100 })).body?.payload?.content;
        if (Array.isArray(list)) suitable = new Set(list.map((row: any) => String(row.productId)));
        console.log(`Акция ${saleId}: ${sale?.title ?? '—'}, ${sale?.startDate ?? '?'} – ${sale?.finishDate ?? '?'}, статус ${sale?.status ?? '?'}; подходящих товаров: ${suitable ? suitable.size : 'не получено'}`);
      } catch (error: any) {
        notes.push(`Товары акции ${saleId} из кабинета не получены (${error?.message || error}) — показаны все SKU`);
      }
    }

    const cfg = PROMO_PLAN_DEFAULTS;
    console.log(`План цен в акции на ${today} — только рекомендации, ничего не меняется.`);
    console.log(`Правила: цена продаж за 28 дн. (нет выкупов — за 90); остаток ≤ ${cfg.lowStockUnits} шт. или запас < ${cfg.lowStockDays} дн. — скидка ${cfg.minDiscountPercent}% от базовой; ≤ ${cfg.slowMaxUnits28} шт. за 28 дн. — на ${cfg.slowCutPercent}% ниже цены продаж; поток — +${cfg.flowRaisePercent}%; не выше базовой −${cfg.minDiscountPercent}%, маржа не ниже ${cfg.minMarginPercent}%.`);
    for (const note of notes) console.log(`⚠️ ${note}`);

    const rows = planPromoPrices(inputs.filter((input) => !suitable || suitable.has(input.productId)), today);
    const products = await prisma.product.findMany({ where: { externalId: { in: [...new Set(rows.map((row) => row.productId))] } }, select: { externalId: true, title: true } });
    const titles = new Map(products.map((row: any) => [String(row.externalId), String(row.title).slice(0, 60)]));
    console.log(formatPromoPlan(rows, titles).join('\n'));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
