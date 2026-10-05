/**
 * Ручной посев фраз в кампании «Буст в ТОП» по файлу спецификации.
 *
 *   npx tsx apps/api/scripts/seed-keywords.ts --spec ~/seed.json           план в консоль, в кабинете ничего не меняется
 *   ... --apply                                                             реально добавить фразы / поставить ставки
 *
 * Файл: [{ "campaignId": "286528", "phrases": [{ "query": "sochiqlar", "cpm": 20000 }, ...] }, ...]
 * Фраза добавляется во все цвета кампании, где её нет; существующей — ставится заданная ставка.
 * Токены берутся из БД (IntegrationCredential) и нигде не печатаются. Журнал — AdBotChange.
 */
import { readFileSync } from 'node:fs';
import { IntegrationType } from '@prisma/client';
import { AD_BOT_LABELS, SeedSpec } from '../src/common/ad-bot';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';
import { AdBotService } from '../src/modules/ads/ad-bot.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

const flag = (name: string) => process.argv.includes(`--${name}`);
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const fmt = (value: number | null) => (value === null ? '—' : Math.round(value).toLocaleString('ru-RU'));

async function main() {
  const specPath = option('spec');
  if (!specPath) throw new Error('нужен --spec <файл.json>');
  const specs = JSON.parse(readFileSync(specPath, 'utf8')) as SeedSpec[];
  if (!Array.isArray(specs) || !specs.length) throw new Error('спецификация пуста');

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
  const service = new AdBotService(prisma, integrations, promo);
  const apply = flag('apply');
  try {
    const { actions, outcomes, keywords } = await service.seed(specs, apply);
    console.log(`${apply ? 'ПРИМЕНЕНО' : 'ПЛАН'}: слов в активных кампаниях ${keywords.length}, действий ${actions.length}\n`);
    for (const spec of specs) {
      const own = actions.filter((row) => row.campaignId === spec.campaignId);
      const all = keywords.filter((row) => row.campaignId === spec.campaignId);
      const name = own[0]?.campaignName ?? all[0]?.campaignName ?? '(кампания не активна или не найдена)';
      const groups = new Set(own.map((row) => row.skuGroupId)).size;
      console.log(`Кампания ${spec.campaignId} «${name}»: слов ${all.length}, цветов ${groups}, действий ${own.length}`);
      if (flag('list')) {
        const latin = all.filter((row) => /[a-z]/i.test(row.query) && !/[а-яё]/i.test(row.query));
        const over = all.filter((row) => row.stopWords.length > 58).length;
        const seen = new Map<string, number>();
        for (const row of all) { const key = `${row.skuGroupId}|${row.query.toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, '').replace(/\s+/g, ' ').trim()}`; seen.set(key, (seen.get(key) ?? 0) + 1); }
        const dupes = [...seen.values()].filter((count) => count > 1).length;
        const withSoch = latin.filter((row) => row.stopWords.some((word) => word.trim().toLowerCase() === 'soch')).length;
        console.log(`  узбекских фраз ${latin.length}; минус-слов на фразу: ${Math.min(...all.map((row) => row.stopWords.length))}–${Math.max(...all.map((row) => row.stopWords.length))}; списков > 58: ${over}; дублей «цвет+фраза»: ${dupes}; узбекских с «soch»: ${withSoch}`);
        for (const row of latin) console.log(`    ${row.skuGroupId}  «${row.query}»  ${fmt(row.cpm)}  минус-слов ${row.stopWords.length}${row.stopWords.some((word) => word.trim().toLowerCase() === 'soch') ? '  [soch]' : ''}`);
      }
      const byQuery = new Map<string, typeof own>();
      for (const row of own) byQuery.set(row.query, [...(byQuery.get(row.query) ?? []), row]);
      for (const [query, rows] of byQuery) {
        const kinds = [...new Set(rows.map((row) => AD_BOT_LABELS[row.kind]))].join(', ');
        const bids = [...new Set(rows.map((row) => `${fmt(row.oldCpm)} → ${fmt(row.newCpm)}`))].join('; ');
        console.log(`  ${kinds}  «${query}»  ×${rows.length} цветов  ${bids}`);
      }
      const soch = keywords.filter((row) => row.campaignId === spec.campaignId && row.stopWords.some((word) => word.trim().toLowerCase() === 'soch'));
      if (soch.length) console.log(`  ⚠ минус-слово «soch» стоит у ${soch.length} слов этой кампании — новым узбекским фразам оно заменено на «soch uchun» / «sochlar uchun»`);
      console.log();
    }
    if (apply) {
      const failed = outcomes.filter((row) => !row.ok);
      console.log(`Итог: готово ${outcomes.length - failed.length}, не подтвердилось ${failed.length}`);
      for (const row of failed) console.log(`  ✗ ${row.action.campaignId} / ${row.action.skuGroupId} «${row.action.query}»: ${row.message}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
