/**
 * Честные зачёркнутые цены («цена до скидки») вместо нереальных «было 600 000»:
 *
 *   npx tsx apps/api/scripts/set-full-prices.ts                 список «было → станет», ничего не меняет
 *   ... --markup 20                                            зачёркнутая = цена продажи +20%, вверх до 1 000 (по умолчанию 20)
 *   ... --sku 8108058                                          только один SKU
 *   ... --apply                                                реально отправить в Uzum (sendPriceData, цена продажи та же)
 *
 * SKU в акции пропускаются: Uzum не даёт менять их цены (sku-price-001) — запускать после окончания акции.
 * Каждая отправка проходит защиты PricingService и пишется в журнал PriceChange (source = cli).
 * Токен Uzum берётся из БД и нигде не печатается.
 */
import { IntegrationType } from '@prisma/client';
import { proposeFullPrice } from '../src/common/pricing';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const fmt = (value: number | null) => (value === null ? '—' : Math.round(value).toLocaleString('ru-RU'));

async function main() {
  const markup = Number(arg('markup') ?? 20);
  if (!Number.isFinite(markup) || markup < 5 || markup > 100) throw new Error('--markup: от 5 до 100 (%)');
  const onlySku = arg('sku');
  const apply = flag('apply');
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
  try {
    const shop = await prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new Error('нет активного магазина');
    const skus = [...(await pricing.liveSkus(shop.externalId)).values()]
      .filter((sku) => !onlySku || sku.skuExternalId === onlySku)
      .sort((a, b) => a.title.localeCompare(b.title));
    console.log(`Зачёркнутая цена = цена продажи +${markup}%, вверх до 1 000 сум. Режим: ${apply ? 'ОТПРАВКА В UZUM' : 'только список, ничего не меняется'}`);
    console.log('SKU | название | цена продажи | зачёркнутая сейчас | станет | результат');
    const counts = { sent: 0, refused: 0, promo: 0, skipped: 0, same: 0 };
    for (const sku of skus) {
      const head = `${sku.skuExternalId} | ${sku.title.replace(/^FAYYOZ-/, '').slice(0, 45)} | ${fmt(sku.price)} | ${fmt(sku.fullPrice)}`;
      if (sku.archived || sku.blocked || !sku.price) { counts.skipped++; console.log(`${head} | — | пропуск: ${sku.archived ? 'архив' : sku.blocked ? 'заблокирован' : 'нет цены'}`); continue; }
      const target = proposeFullPrice(sku.price, markup);
      if (sku.fullPrice === target) { counts.same++; console.log(`${head} | ${fmt(target)} | уже так`); continue; }
      if (sku.inPromo) { counts.promo++; console.log(`${head} | ${fmt(target)} | в акции${sku.promoName ? ` «${sku.promoName}»` : ''} — после её окончания`); continue; }
      if (!apply) { console.log(`${head} | ${fmt(target)} | будет изменено`); continue; }
      try {
        const result: any = await pricing.sendPrice(sku.skuExternalId, sku.price, { dryRun: false, fullPrice: target, source: 'cli', reason: `зачёркнутая цена +${markup}%` });
        if (result.sent) { counts.sent++; console.log(`${head} | ${fmt(target)} | ✅ отправлено`); }
        else { counts.refused++; console.log(`${head} | ${fmt(target)} | ❌ отказ: ${(result.violations || []).map((v: any) => v.message).join('; ')}`); }
      } catch (error: any) {
        counts.refused++;
        console.log(`${head} | ${fmt(target)} | ❌ ${String(error?.response?.message || error?.message || error)}`);
      }
    }
    console.log(`\nИтого SKU: ${skus.length}; отправлено ${counts.sent}, отказов ${counts.refused}, в акции ${counts.promo}, уже так ${counts.same}, пропущено ${counts.skipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
