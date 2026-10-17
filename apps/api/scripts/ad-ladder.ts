/**
 * Ручной запуск «лестницы ставок» (common/ad-ladder.ts, AdLadderService) без поднятия всего API.
 *
 *   npx tsx --tsconfig apps/api/tsconfig.json apps/api/scripts/ad-ladder.ts     предложения в консоль, в кабинете ничего не меняется
 *   ... --apply                                      реально поставить ставки
 *   ... --telegram                                   ещё и отправить отчёт в Telegram
 *   ... --campaign 286528                            только эти кампании (по умолчанию — ladderCampaigns())
 *
 * Токены берутся из БД (IntegrationCredential) и нигде не печатаются.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';
import { AdBotService } from '../src/modules/ads/ad-bot.service';
import { AdLadderService } from '../src/modules/ads/ad-ladder.service';
import { AutoBidderService } from '../src/modules/ads/auto-bidder.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

const flag = (name: string) => process.argv.includes(`--${name}`);
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

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
    async notifyTelegram(text: string, opt = 'notifyErrors') {
      const stored = await getPlain(IntegrationType.TELEGRAM);
      const chatId = String(stored?.metadata?.chatId || '');
      if (!stored?.token || !chatId || stored.metadata?.[opt] === false) return false;
      await new TelegramClient().sendMessage(stored.token, chatId, text);
      return true;
    },
  } as unknown as IntegrationsService;
  const promo = new PromoPricingService(prisma, integrations, new PricingService(prisma, integrations));
  const adBot = new AdBotService(prisma, integrations, promo);
  const service = new AdLadderService(prisma, integrations, adBot, new AutoBidderService(prisma, integrations, promo, adBot));
  try {
    const campaign = option('campaign');
    const result = await service.run({ apply: flag('apply'), notify: flag('telegram'), campaignIds: campaign ? campaign.split(',') : undefined });
    console.log(result.report);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
