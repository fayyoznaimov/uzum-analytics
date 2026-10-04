/**
 * Ценовые эксперименты: оценка изменений цены через 7 дней по воронке Uzum
 * против контроля (SKU того же товара без изменений). Пишет вердикт в
 * PriceChange.evaluation. По расписанию — PriceExperimentService (10:20).
 *
 *   npx tsx --env-file=../../.env --tsconfig tsconfig.json scripts/price-experiments.ts [--telegram]
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';
import { PriceExperimentService } from '../src/modules/pricing/price-experiment.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
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
  const promo = new PromoPricingService(prisma, integrations, new PricingService(prisma, integrations));
  const service = new PriceExperimentService(prisma, integrations, promo);
  try {
    const result = await service.run({ notify: flag('telegram') });
    console.log(result.messages.join('\n\n') || `Созревших изменений цены нет (оценено ${result.evaluated}).`);
    const learned = await service.learnings();
    if (learned) console.log(`\nОпыт магазина за 90 дней: ${learned}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
