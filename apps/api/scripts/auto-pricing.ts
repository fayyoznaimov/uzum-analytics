/**
 * Ручной запуск автоцен без поднятия всего API (и его cron-задач).
 *
 *   npx tsx apps/api/scripts/auto-pricing.ts               отчёт в консоль, цены не меняются
 *   ... --telegram                                        ещё и отправить отчёт в Telegram
 *   ... --dump-stock                                      первая страница getProducts кабинета как есть (проверить поля запаса)
 *   ... --apply                                           реально изменить цены (как AUTO_PRICING_APPLY=true)
 *
 * Токены берутся из БД (IntegrationCredential) и нигде не печатаются.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { OpenclawClient } from '../src/common/openclaw.client';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { AutoPricingService } from '../src/modules/pricing/auto-pricing.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const prisma = new PrismaService();
  const crypto = new CryptoService();
  const getPlain = async (type: IntegrationType) => {
    const row = await prisma.integrationCredential.findUnique({ where: { type } });
    if (!row || !row.enabled) return null;
    const token = crypto.decrypt(row);
    return token ? { token, metadata: (row.metadata || {}) as any, row } : null;
  };
  const integrations = {
    getPlain,
    async notifyTelegram(text: string, option = 'notifyErrors') {
      const stored = await getPlain(IntegrationType.TELEGRAM);
      const chatId = String(stored?.metadata?.chatId || '');
      if (!stored?.token || !chatId || stored.metadata?.[option] === false) return false;
      await new TelegramClient().sendMessage(stored.token, chatId, text);
      return true;
    },
  } as unknown as IntegrationsService;
  const pricing = new PricingService(prisma, integrations);
  const promo = new PromoPricingService(prisma, integrations, pricing);
  const service = new AutoPricingService(prisma, integrations, pricing, promo, new OpenclawClient());
  try {
    if (flag('dump-stock')) {
      const { forecasts, raw } = await promo.cabinetStock();
      const first: any = [(raw as any)?.productList, (raw as any)?.payload?.productList, (raw as any)?.payload?.content, (raw as any)?.content, (raw as any)?.payload].find(Array.isArray)?.[0];
      console.log(JSON.stringify({ topLevelKeys: Object.keys((raw as any) || {}), payloadKeys: Object.keys((raw as any)?.payload || {}), firstProduct: first ?? null, parsed: forecasts.slice(0, 10) }, null, 2));
      return;
    }
    const result = await service.run({ apply: flag('apply'), notify: flag('telegram') });
    console.log(result.messages.join('\n\n'));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
