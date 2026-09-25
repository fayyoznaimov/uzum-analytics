/**
 * Ручной запуск PromoPricingService без поднятия всего API (и его cron-задач).
 *
 *   npx tsx apps/api/scripts/send-promo-price.ts --list [--sku 10616545]   цены в акциях и лимиты «не более»
 *   npx tsx apps/api/scripts/send-promo-price.ts --sku 10616545 --price 29600 --min 20000
 *   ... --apply            реально отправить (без флага — только dry-run)
 *   ... --sale 393         акция, если SKU сразу в нескольких
 *   ... --max-step 5       шаг изменения, % (по умолчанию PRICE_MAX_STEP_PERCENT или 5)
 *   ... --reason "текст"
 *
 * Токен кабинета берётся из БД (IntegrationCredential UZUM_INTERNAL) и нигде не печатается.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const numberArg = (name: string) => (arg(name) === undefined ? undefined : Number(arg(name)));

async function main() {
  const sku = arg('sku');
  const price = numberArg('price');
  if (!flag('list') && (!sku || !price)) throw new Error('Нужны --list или --sku <skuId> --price <цена>');
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
  const service = new PromoPricingService(prisma, integrations, new PricingService(prisma, integrations));
  try {
    const result = flag('list')
      ? await service.promoPrices(sku)
      : await service.sendPromoPrice(sku as string, price as number, {
        dryRun: !flag('apply'),
        saleId: numberArg('sale'),
        minPrice: numberArg('min'),
        maxStepPercent: numberArg('max-step'),
        reason: arg('reason'),
        source: 'cli',
      });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
