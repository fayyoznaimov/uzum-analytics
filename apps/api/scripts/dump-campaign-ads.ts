/**
 * Сырой список объявлений кампании «Буст в ТОП» — какие группы и статусы отдаёт кабинет.
 *
 *   npx tsx apps/api/scripts/dump-campaign-ads.ts --campaign 286528 [--raw]
 *   ... --ads                                   каждое объявление строкой: id, фраза, ставка
 *
 * Токен кабинета берётся из БД (UZUM_INTERNAL) и нигде не печатается.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PricingService } from '../src/modules/pricing/pricing.service';
import { PromoPricingService } from '../src/modules/pricing/promo-pricing.service';

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const campaignId = option('campaign');
  if (!campaignId) throw new Error('нужен --campaign <id>');
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
  const cabinet = new PromoPricingService(prisma, integrations, new PricingService(prisma, integrations));
  const base = 'https://api-seller.uzum.uz/api/seller';
  try {
    const details = (await cabinet.cabinet('GET', `${base}/advertising/management/ad-campaign/${campaignId}`)).body;
    console.log('кампания:', JSON.stringify({ name: details?.payload?.name, status: details?.payload?.status, budgetConfig: details?.payload?.budgetConfig, skuGroupsCount: details?.payload?.skuGroupsCount, keys: Object.keys(details?.payload ?? {}) }));
    const probe = option('probe');
    if (probe) {
      // --probe 4038325-4038345,5856535-5856548: какие id групп существуют и какие SKU в них.
      const ids: string[] = [];
      for (const part of probe.split(',')) {
        const [from, to] = part.split('-').map(Number);
        for (let id = from; id <= (to || from); id++) ids.push(String(id));
      }
      const shopId = await cabinet.cabinetShopId();
      const titles = new Map<string, { title: string; quantity: number }>();
      for (let page = 0; page < 30; page++) {
        const body = (await cabinet.cabinet('GET', `${base}/shop/${shopId}/product/getProducts`, { page, size: 100 })).body;
        const products: any[] = Array.isArray(body?.productList) ? body.productList : [];
        for (const product of products) for (const sku of product.skuList ?? []) titles.set(String(sku.skuId), { title: String(sku.skuTitle ?? sku.skuFullTitle ?? '').replace(/^FAYYOZ-/, ''), quantity: Number(sku.quantityActive) || 0 });
        if (products.length < 100) break;
      }
      for (let index = 0; index < ids.length; index += 20) {
        const body = (await cabinet.cabinet('GET', `${base}/product/skugroup/sku`, { skuGroupIds: ids.slice(index, index + 20).join(',') })).body;
        for (const group of Array.isArray(body?.payload) ? body.payload : []) {
          const skus = (group.skuShortInfoDtos ?? []).map((sku: any) => titles.get(String(sku.skuId)) ?? { title: `#${sku.skuId}`, quantity: 0 });
          console.log(`группа ${group.skuGroupId}: ${skus.map((s: any) => `${s.title} (${s.quantity})`).join(', ')}`);
        }
      }
    }
    const productId = option('groups');
    if (productId) {
      const shopId = await cabinet.cabinetShopId();
      const tries = [
        [`${base}/product/skugroup`, { productId }],
        [`${base}/shop/${shopId}/product/${productId}/skugroup`, undefined],
        [`${base}/advertising/management/sku-group`, { productId }],
        [`${base}/advertising/management/ad-campaign/${campaignId}/sku-group`, undefined],
        [`${base}/advertising/management/sku-groups`, { productId, campaignId }],
      ] as Array<[string, Record<string, string> | undefined]>;
      for (const [url, params] of tries) {
        try {
          const body = (await cabinet.cabinet('GET', url, params)).body;
          console.log('GET', url.replace(base, ''), params ?? '', '→', JSON.stringify(body).slice(0, 600));
        } catch (error: any) {
          console.log('GET', url.replace(base, ''), params ?? '', '→ ошибка:', String(error?.message || error).slice(0, 120));
        }
      }
    }
    for (let page = 0; page < 30; page++) {
      const body = (await cabinet.cabinet('GET', `${base}/advertising/management/ad-campaign/${campaignId}/advertisement`, { page, size: 10 })).body;
      const groups: any[] = Array.isArray(body?.payload?.skuGroupAdvertisements) ? body.payload.skuGroupAdvertisements : [];
      if (page === 0) console.log('ключи payload:', Object.keys(body?.payload ?? {}), '| ключи группы:', Object.keys(groups[0] ?? {}), '| ключи объявления:', Object.keys(groups[0]?.advertisements?.[0] ?? {}));
      for (const group of groups) {
        const ads: any[] = Array.isArray(group.advertisements) ? group.advertisements : [];
        const statuses = [...new Set(ads.map((ad) => String(ad.status ?? ad.state ?? '—')))].join(',');
        const types = [...new Set(ads.map((ad) => String(ad.promotionType ?? '—')))].join(',');
        console.log(`стр.${page} группа ${group.skuGroupId} «${group.skuGroupName ?? group.name ?? group.title ?? ''}» статус группы ${group.status ?? '—'} объявлений ${ads.length} статусы [${statuses}] типы [${types}]`);
        if (flag('raw')) console.log(JSON.stringify(group).slice(0, 1500));
        // --ads: каждое объявление строкой — id, фраза, ставка, число минус-слов (новые объявления — с наибольшим id).
        if (flag('ads')) for (const ad of ads) console.log(`объявление ${ad.id} | группа ${group.skuGroupId} | «${ad.query}» | ${ad.cpm} | минус-слов ${Array.isArray(ad.stopWords) ? ad.stopWords.length : 0}`);
      }
      if (groups.length < 10) break;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.response?.message || error?.message || error));
  process.exit(1);
});
