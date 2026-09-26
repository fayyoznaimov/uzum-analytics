/**
 * Ручной запуск агента по рекламе без поднятия всего API.
 *
 *   npx tsx apps/api/scripts/ad-agent.ts             отчёт в консоль
 *   ... --telegram                                  ещё и отправить отчёт в Telegram
 *
 * Только советы: ставки и бюджеты в кабинете не меняются. Токены берутся из БД и нигде не печатаются.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { OpenclawClient } from '../src/common/openclaw.client';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';
import { AdAgentService } from '../src/modules/ads/ad-agent.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

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
  const promo = new PromoPricingService(prisma, integrations, new PricingService(prisma, integrations));
  const service = new AdAgentService(integrations, promo, new OpenclawClient());
  try {
    const result = await service.run({ notify: process.argv.includes('--telegram') });
    console.log(result.messages.join('\n\n'));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
