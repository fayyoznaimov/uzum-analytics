/**
 * Ручной запуск PricingService.sendPrice без поднятия всего API (и его cron-задач).
 *
 *   npx tsx apps/api/scripts/send-price.ts --sku 11100529 --price 58900 --min 50000
 *   ... --apply            реально отправить (без флага — только dry-run)
 *   ... --max-step 5       шаг изменения, % (по умолчанию PRICE_MAX_STEP_PERCENT или 5)
 *   ... --full-price N     дополнительно передать полную (зачёркнутую) цену
 *   ... --with-title       передать skuTitle из Uzum вместе с ценой
 *   ... --allow-promo      разрешить изменение SKU, участвующего в акции
 *   ... --reason "текст"
 *
 * Токен Uzum берётся из БД (IntegrationCredential UZUM) и нигде не печатается.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const numberArg = (name: string) => (arg(name) === undefined ? undefined : Number(arg(name)));

async function main() {
  const sku = arg('sku');
  const price = numberArg('price');
  if (!sku || !price) throw new Error('Нужны --sku <skuId> и --price <цена>');
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
  try {
    const result = await new PricingService(prisma, integrations).sendPrice(sku, price, {
      dryRun: !flag('apply'),
      minPrice: numberArg('min'),
      maxStepPercent: numberArg('max-step'),
      fullPrice: numberArg('full-price'),
      withSkuTitle: flag('with-title'),
      allowDuringPromo: flag('allow-promo'),
      reason: arg('reason'),
      source: 'cli',
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
