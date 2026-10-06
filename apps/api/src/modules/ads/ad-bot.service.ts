import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import {
  AD_BOT_DEFAULTS,
  AdBotAction,
  AdBotConfig,
  AdBotFeedQuery,
  AdBotGroup,
  AdBotKeyword,
  AdBotOutcome,
  AdBotPlan,
  AdBotStats,
  buildCampaignUpdate,
  formatAdBotReport,
  normalizeQuery,
  planAdBot,
  seedKeywordActions,
  SeedSpec,
} from '../../common/ad-bot';
import { cubeUrl, isCubeContinueWait } from '../../common/ad-agent';
import { shiftDay, tashkentDay } from '../../common/auto-pricing';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PromoPricingService } from '../pricing/promo-pricing.service';

const CABINET = 'https://api-seller.uzum.uz/api/seller';
const CAMPAIGNS_PAGE = 20;
const ADS_PAGE = 10;
const MAX_PAGES = 30;
const DAILY = 'AdvertisingDailyFunnel.';
const FEED = 'AdvertisingFeedDailyFunnel.';

export type AdBotRunResult = { apply: boolean; today: string; keywords: AdBotKeyword[]; plan: AdBotPlan; outcomes: AdBotOutcome[]; notes: string[]; messages: string[] };

type CampaignInfo = { id: string; name: string; budgetConfig: any; period: any };

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Комиссия 22% + налог 1% и логистика Uzum за штуку — осторожная оценка маржи только для потолка ДРР (A12),
 * не для цен: точную маржу по выплатам считают автоцены. */
const COMMISSION_AND_TAX = 0.23;
const LOGISTICS_PER_UNIT = 7_500;
const marginAtPrice = (price: number, unitCost: number) => ((price * (1 - COMMISSION_AND_TAX) - LOGISTICS_PER_UNIT - unitCost) / price) * 100;

/**
 * Рекламный бот «Буст в ТОП»: раз в день (11:00 по Ташкенту, AD_BOT_CRON) читает слова активных кампаний,
 * статистику слов и реальные запросы покупателей из Cube кабинета, решает по правилам common/ad-bot.ts,
 * добавляет минус-слова по нерелевантным запросам и присылает отчёт в Telegram. По умолчанию — только предложения;
 * AD_BOT_APPLY=true — меняет ставки / слова / минус-слова через PUT кампании. Бюджеты и названия кампаний не трогает. Журнал — AdBotChange.
 */
@Injectable()
export class AdBotService {
  private readonly logger = new Logger(AdBotService.name);
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly cabinet: PromoPricingService,
  ) {}

  @Cron(process.env.AD_BOT_CRON || '0 11 * * *', { name: 'ad-bot', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    if (process.env.AD_BOT_ENABLED === 'false') return;
    this.logger.log('Рекламный бот: запуск по расписанию');
    try {
      await this.run({ apply: process.env.AD_BOT_APPLY === 'true', notify: true });
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`Рекламный бот: ${message}`);
      await this.integrations.notifyTelegram(`⚠️ Рекламный бот: запуск не выполнен — ${message}`, 'notifyAgents').catch(() => undefined);
    }
  }

  config(): AdBotConfig {
    const env = (name: string) => {
      const value = Number(process.env[name]);
      return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) && value > 0 ? value : null;
    };
    return {
      ...AD_BOT_DEFAULTS,
      maxDrrPercent: env('AD_AGENT_MAX_DRR_PERCENT') ?? AD_BOT_DEFAULTS.maxDrrPercent,
      maxBid: env('AD_BOT_MAX_BID') ?? AD_BOT_DEFAULTS.maxBid,
      maxChangesPerRun: env('AD_BOT_MAX_CHANGES') ?? AD_BOT_DEFAULTS.maxChangesPerRun,
      campaignMaxBid: Object.fromEntries(
        String(process.env.AD_BOT_CAMPAIGN_MAX_BID || '').split(',').map((pair) => pair.split(':').map((part) => part.trim()))
          .filter(([id, cap]) => id && Number.isFinite(Number(cap)) && Number(cap) > 0).map(([id, cap]) => [id, Number(cap)]),
      ),
    };
  }

  async run(options: { apply: boolean; notify: boolean }): Promise<AdBotRunResult> {
    if (this.running) throw new Error('рекламный бот уже выполняется');
    this.running = true;
    try {
      const now = new Date();
      const today = tashkentDay(now);
      const cfg = this.config();
      const { campaigns, input, notes } = await this.collect(now, today);
      const plan = planAdBot(input, cfg);
      const outcomes = options.apply ? await this.apply(plan.actions, campaigns, input) : [];
      if (!options.apply) await this.journal(plan.actions, input, { dryRun: true, status: 'PLANNED' });

      const label = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now);
      const messages = formatAdBotReport({ label, apply: options.apply, plan, outcomes, notes, keywordsCount: input.keywords.length });
      if (options.notify) {
        for (const text of messages) {
          if (!(await this.integrations.notifyTelegram(text, 'notifyAgents'))) {
            this.logger.warn('Рекламный бот: отчёт не отправлен — Telegram не настроен или выключено «Автоцены и реклама»');
            break;
          }
        }
      }
      this.logger.log(`Рекламный бот (${options.apply ? 'изменения' : 'предложения'}): слов ${input.keywords.length}, изменений ${plan.actions.length}, ошибок ${outcomes.filter((row) => !row.ok).length}`);
      return { apply: options.apply, today, keywords: input.keywords, plan, outcomes, notes, messages };
    } finally {
      this.running = false;
    }
  }

  private async get(url: string, params?: Record<string, string | number>) {
    return (await this.cabinet.cabinet('GET', url, params)).body;
  }

  /** Cube: строки ответа как есть; «Continue wait» — повторяем до ~30 секунд. */
  private async cubeRows(query: Record<string, unknown>): Promise<any[]> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const { body } = await this.cabinet.cabinet('GET', cubeUrl(query));
      if (isCubeContinueWait(body)) { await new Promise((resolve) => setTimeout(resolve, 2_000)); continue; }
      if (body?.error) throw new Error(`Cube: ${String(body.error).slice(0, 200)}`);
      const rows = body?.results?.[0]?.data ?? body?.data;
      if (!Array.isArray(rows)) throw new Error('Cube: неожиданная форма ответа (нет results[0].data)');
      return rows;
    }
    throw new Error('Cube не посчитал данные за 30 секунд');
  }

  private async keywordStats(sellerId: string, from: string, to: string): Promise<Map<string, AdBotStats>> {
    const rows = await this.cubeRows({
      measures: ['impressions_sum', 'clicks_sum', 'sold_quantity_sum', 'revenue_final', 'expenses_sum', 'weighted_average_position'].map((m) => DAILY + m),
      dimensions: [DAILY + 'bid_id'],
      timezone: 'Asia/Tashkent',
      timeDimensions: [{ dimension: DAILY + 'date', dateRange: [from, to] }],
      filters: [{ member: DAILY + 'seller_id', operator: 'equals', values: [sellerId] }],
      limit: 10_000,
    });
    const result = new Map<string, AdBotStats>();
    for (const row of rows) {
      const id = String(row[DAILY + 'bid_id'] ?? '');
      if (!id) continue;
      const position = Number(row[DAILY + 'weighted_average_position']);
      result.set(id, {
        impressions: num(row[DAILY + 'impressions_sum']),
        clicks: num(row[DAILY + 'clicks_sum']),
        sold: num(row[DAILY + 'sold_quantity_sum']),
        revenue: num(row[DAILY + 'revenue_final']),
        spend: num(row[DAILY + 'expenses_sum']),
        position: row[DAILY + 'weighted_average_position'] === null || !Number.isFinite(position) ? null : position,
      });
    }
    return result;
  }

  /** Ручной посев фраз по спецификации (scripts/seed-keywords.ts): без правил бота, но с его проверкой и журналом. */
  async seed(specs: SeedSpec[], apply: boolean): Promise<{ actions: AdBotAction[]; outcomes: AdBotOutcome[]; keywords: AdBotKeyword[]; groupTitles: Map<string, string>; budgetNotes: string[] }> {
    const today = tashkentDay(new Date());
    const sellerId = await this.resolveSellerId(today);
    const { campaigns, keywords } = await this.loadCampaigns(sellerId, today);
    const actions = seedKeywordActions(keywords, specs, this.config());
    const empty = { stats14: new Map<string, AdBotStats>(), stats7: new Map<string, AdBotStats>() };
    const budgets = new Map<string, { weeklyAmount?: number; uniform?: boolean }>();
    for (const spec of specs) {
      if (spec.campaignId !== '*' && (spec.budgetWeekly !== undefined || spec.uniform !== undefined)) budgets.set(spec.campaignId, { weeklyAmount: spec.budgetWeekly, uniform: spec.uniform });
    }
    const budgetNotes: string[] = [];
    for (const [campaignId, budget] of budgets) {
      const campaign = campaigns.get(campaignId);
      if (!campaign) { budgetNotes.push(`${campaignId}: кампания не активна — бюджет не менялся`); continue; }
      budgetNotes.push(`${campaignId} «${campaign.name}»: бюджет ${Number(campaign.budgetConfig?.weeklyAmount) || 0} → ${budget.weeklyAmount ?? 'без изменений'}, равномерно: ${budget.uniform ?? Boolean(campaign.budgetConfig?.uniformDistribution)}`);
    }
    const outcomes = apply ? await this.apply(actions, campaigns, empty, budgets) : [];
    if (apply) {
      // Кампании, где меняется только бюджет (действий по словам нет): отдельный PUT без объявлений.
      for (const [campaignId, budget] of budgets) {
        const campaign = campaigns.get(campaignId);
        if (!campaign || actions.some((row) => row.campaignId === campaignId)) continue;
        try {
          await this.cabinet.cabinet('PUT', `${CABINET}/advertising/management/ad-campaign/${campaignId}`, undefined, buildCampaignUpdate(campaign, [], budget));
          budgetNotes.push(`${campaignId}: бюджет отправлен`);
        } catch (error: any) {
          budgetNotes.push(`${campaignId}: бюджет НЕ отправлен — ${String(error?.message || error).slice(0, 200)}`);
        }
      }
    }
    if (!apply) await this.journal(actions, empty, { dryRun: true, status: 'PLANNED' });
    const groupTitles = await this.groupTitles([...new Set(keywords.map((row) => row.skuGroupId))]);
    return { actions, outcomes, keywords, groupTitles, budgetNotes };
  }

  /** Названия цветов по id групп: группа → SKU → skuTitle из getProducts. */
  private async groupTitles(groupIds: string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    if (!groupIds.length) return titles;
    const shopId = await this.cabinet.cabinetShopId();
    const skusByGroup = new Map<string, string[]>();
    for (let index = 0; index < groupIds.length; index += 20) {
      const body = await this.get(`${CABINET}/product/skugroup/sku`, { skuGroupIds: groupIds.slice(index, index + 20).join(',') });
      for (const group of Array.isArray(body?.payload) ? body.payload : []) {
        skusByGroup.set(String(group.skuGroupId), (group.skuShortInfoDtos ?? []).map((sku: any) => String(sku.skuId)));
      }
    }
    const skuTitle = new Map<string, string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(`${CABINET}/shop/${shopId}/product/getProducts`, { page, size: 100 });
      const products: any[] = Array.isArray(body?.productList) ? body.productList : [];
      for (const product of products) {
        for (const sku of Array.isArray(product.skuList) ? product.skuList : []) skuTitle.set(String(sku.skuId), String(sku.skuTitle ?? sku.skuFullTitle ?? '').replace(/^FAYYOZ-/, ''));
      }
      if (products.length < 100) break;
    }
    for (const [groupId, skus] of skusByGroup) {
      const names = skus.map((id) => skuTitle.get(id)).filter(Boolean) as string[];
      if (names.length) titles.set(groupId, names[0].replace(/-(50 x 90|70 x140|Havana|Банный|Лицевой|Микс|Сауна|банн\S*|лицев\S*|микс|сауна)$/i, ''));
    }
    return titles;
  }

  /** Список SKU кабинета с ценой и остатком — для ручных правок цен (scripts/seed-keywords.ts --skus <фильтр>). */
  async listSkus(filter: string): Promise<Array<{ skuId: string; title: string; price: number; quantity: number }>> {
    const shopId = await this.cabinet.cabinetShopId();
    const rows: Array<{ skuId: string; title: string; price: number; quantity: number }> = [];
    const needle = filter.toLowerCase();
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(`${CABINET}/shop/${shopId}/product/getProducts`, { page, size: 100 });
      const products: any[] = Array.isArray(body?.productList) ? body.productList : [];
      for (const product of products) {
        for (const sku of Array.isArray(product.skuList) ? product.skuList : []) {
          const title = String(sku.skuTitle ?? sku.skuFullTitle ?? '');
          if (!needle || title.toLowerCase().includes(needle)) rows.push({ skuId: String(sku.skuId), title, price: num(sku.price), quantity: num(sku.quantityActive) });
        }
      }
      if (products.length < 100) break;
    }
    return rows.sort((a, b) => a.title.localeCompare(b.title));
  }

  private async resolveSellerId(today: string): Promise<string> {
    const cpoBody = (await this.cabinet.cabinet('POST', `${CABINET}/cpo/advertisements/search`, undefined, { page: 0, size: 1, activeOnly: false, dateTo: today })).body;
    const sellerId = String(cpoBody?.payload?.advertisements?.[0]?.ownerSellerId ?? process.env.UZUM_SELLER_ID ?? '');
    if (!sellerId) throw new Error('не удалось определить sellerId (нет объявлений «Буст заказов» и не задан UZUM_SELLER_ID)');
    return sellerId;
  }

  /** Активные кампании «Буст в ТОП» и их слова (кабинет отдаёт не больше 20 кампаний и 10 слов за страницу). */
  private async loadCampaigns(sellerId: string, today: string): Promise<{ campaigns: Map<string, CampaignInfo>; keywords: AdBotKeyword[] }> {
    const campaignRows: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(`${CABINET}/advertising/management/ad-campaign`, { sellerId, page, size: CAMPAIGNS_PAGE, from: shiftDay(today, -28), to: today, statusGroup: 'ALL' });
      const rows: any[] = Array.isArray(body?.payload) ? body.payload : [];
      campaignRows.push(...rows);
      if (rows.length < CAMPAIGNS_PAGE) break;
    }
    const campaigns = new Map<string, CampaignInfo>();
    const keywords: AdBotKeyword[] = [];
    for (const row of campaignRows.filter((item) => String(item.status) === 'ACTIVE')) {
      const id = String(row.id);
      const details = (await this.get(`${CABINET}/advertising/management/ad-campaign/${id}`))?.payload ?? row;
      const info: CampaignInfo = { id, name: String(details.name ?? row.name ?? id), budgetConfig: details.budgetConfig ?? row.budgetConfig, period: details.period ?? row.period };
      campaigns.set(id, info);
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await this.get(`${CABINET}/advertising/management/ad-campaign/${id}/advertisement`, { page, size: ADS_PAGE });
        const groups: any[] = Array.isArray(body?.payload?.skuGroupAdvertisements) ? body.payload.skuGroupAdvertisements : [];
        for (const group of groups) {
          for (const ad of Array.isArray(group.advertisements) ? group.advertisements : []) {
            if (String(ad.promotionType ?? 'QUERY') !== 'QUERY' || !ad.query || !Number.isFinite(Number(ad.cpm))) continue;
            keywords.push({
              campaignId: id, campaignName: info.name, adId: String(ad.id), skuGroupId: String(ad.skuGroupId ?? group.skuGroupId),
              query: String(ad.query), cpm: Number(ad.cpm), stopWords: Array.isArray(ad.stopWords) ? ad.stopWords.map(String) : [],
            });
          }
        }
        if (groups.length < ADS_PAGE) break;
      }
    }
    return { campaigns, keywords };
  }

  private async collect(now: Date, today: string) {
    const notes: string[] = [];
    const yesterday = shiftDay(today, -1);
    const shopId = await this.cabinet.cabinetShopId();
    const sellerId = await this.resolveSellerId(today);
    const { campaigns, keywords } = await this.loadCampaigns(sellerId, today);

    // Остатки и цены цветов: группа → SKU (кабинет) → quantityActive / price из getProducts.
    const groupIds = [...new Set(keywords.map((row) => row.skuGroupId))];
    const skusByGroup = new Map<string, string[]>();
    for (let index = 0; index < groupIds.length; index += 20) {
      const body = await this.get(`${CABINET}/product/skugroup/sku`, { skuGroupIds: groupIds.slice(index, index + 20).join(',') });
      for (const group of Array.isArray(body?.payload) ? body.payload : []) {
        skusByGroup.set(String(group.skuGroupId), (group.skuShortInfoDtos ?? []).map((sku: any) => String(sku.skuId)));
      }
    }
    type SkuInfo = { quantity: number; price: number; title: string; avgDailySales: number | null; unitCost: number | null };
    const skuInfo = new Map<string, SkuInfo>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(`${CABINET}/shop/${shopId}/product/getProducts`, { page, size: 100 });
      const products: any[] = Array.isArray(body?.productList) ? body.productList : [];
      for (const product of products) {
        for (const sku of Array.isArray(product.skuList) ? product.skuList : []) {
          const avg = Number(sku.avgdsales ?? sku.avgDailySales);
          skuInfo.set(String(sku.skuId), {
            quantity: num(sku.quantityActive), price: num(sku.price), title: String(sku.skuTitle ?? sku.skuFullTitle ?? '').replace(/^FAYYOZ-/, ''),
            avgDailySales: Number.isFinite(avg) && avg >= 0 ? avg : null, unitCost: null,
          });
        }
      }
      if (products.length < 100) break;
    }
    // Себестоимость — та же выборка, что у автоцен (действующая запись SkuCost).
    const costRows = await this.prisma.sku.findMany({
      where: { externalId: { in: [...skuInfo.keys()] } },
      include: { costs: { where: { validTo: null }, orderBy: { validFrom: 'desc' }, take: 1 } },
    });
    for (const row of costRows) {
      const cost = row.costs[0];
      const info = skuInfo.get(String(row.externalId));
      if (!cost || !info) continue;
      const unitCost = Number(cost.amount) + Number(cost.packagingCost) + Number(cost.additionalCost) + Number(cost.warehouseLogisticsCost);
      info.unitCost = unitCost > 0 ? unitCost : null;
    }
    const groups = new Map<string, AdBotGroup>();
    for (const groupId of groupIds) {
      const skus = (skusByGroup.get(groupId) ?? []).map((id) => skuInfo.get(id)).filter((row): row is SkuInfo => Boolean(row));
      const priced = skus.filter((row) => row.price > 0);
      const stock = skus.length ? skus.reduce((sum, row) => sum + row.quantity, 0) : null;
      const withSales = skus.filter((row) => row.avgDailySales !== null);
      const dailySales = withSales.reduce((sum, row) => sum + (row.avgDailySales as number), 0);
      const margins = priced.filter((row) => row.unitCost !== null).map((row) => marginAtPrice(row.price, row.unitCost as number));
      groups.set(groupId, {
        skuGroupId: groupId,
        title: skus[0]?.title.replace(/-(50 x 90|70 x140|Havana|Банный|Лицевой|Микс|Сауна|банн\S*|лицев\S*|микс|сауна)$/i, '') || groupId,
        stock,
        price: priced.length ? Math.max(...priced.map((row) => row.price)) : null,
        daysOfStock: stock === null || !withSales.length ? null : dailySales > 0 ? stock / dailySales : stock > 0 ? Infinity : null,
        marginPercent: margins.length ? Math.min(...margins) : null,
      });
    }
    if (groupIds.some((id) => !skusByGroup.has(id))) notes.push('для части цветов не получен состав SKU — остаток для них не проверялся');

    // Статистика слов и реальные запросы покупателей.
    const stats14 = await this.keywordStats(sellerId, shiftDay(yesterday, -13), yesterday);
    const stats7 = await this.keywordStats(sellerId, shiftDay(yesterday, -6), yesterday);
    const feedRows = await this.cubeRows({
      measures: ['impressions_sum', 'clicks_sum', 'atc_quantity_sum', 'sold_quantity_sum', 'revenue_final'].map((m) => FEED + m),
      dimensions: [FEED + 'sku_group_id', FEED + 'search_query'],
      timezone: 'Asia/Tashkent',
      timeDimensions: [{ dimension: FEED + 'date', dateRange: [shiftDay(yesterday, -27), yesterday] }],
      filters: [{ member: FEED + 'seller_id', operator: 'equals', values: [sellerId] }],
      order: { [FEED + 'impressions_sum']: 'desc' },
      limit: 10_000,
    });
    const feed: AdBotFeedQuery[] = feedRows.map((row) => ({
      skuGroupId: String(row[FEED + 'sku_group_id'] ?? ''),
      searchQuery: String(row[FEED + 'search_query'] ?? ''),
      impressions: num(row[FEED + 'impressions_sum']),
      clicks: num(row[FEED + 'clicks_sum']),
      atc: num(row[FEED + 'atc_quantity_sum']),
      sold: num(row[FEED + 'sold_quantity_sum']),
      revenue: num(row[FEED + 'revenue_final']),
    })).filter((row) => row.skuGroupId && row.searchQuery);

    const history = await this.prisma.adBotChange.findMany({
      where: { status: 'SENT', dryRun: false, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      orderBy: { createdAt: 'desc' },
    });
    // id ключа меняется при каждой правке, поэтому и кулдаун, и статистика
    // привязаны к паре «цвет|запрос». Старые id связываются с ключом через
    // журнал бота (adId — id до правки, response.newAdId — после).
    const keyOf = (skuGroupId: string, query: string) => `${skuGroupId}|${normalizeQuery(query)}`;
    const lastChange = new Map<string, Date>();
    const idsByKey = new Map<string, Set<string>>();
    const addId = (key: string, id: unknown) => { if (id) idsByKey.set(key, (idsByKey.get(key) ?? new Set()).add(String(id))); };
    for (const row of history as any[]) {
      const key = keyOf(row.skuGroupId, row.query);
      if (!lastChange.has(key)) lastChange.set(key, row.createdAt);
      addId(key, row.adId);
      addId(key, row.response?.newAdId);
    }
    for (const keyword of keywords) {
      const key = keyOf(keyword.skuGroupId, keyword.query);
      addId(key, keyword.adId);
      // Решения в common/ad-bot смотрят lastChange и статистику по adId
      // текущего объявления — переносим на него данные всего ключа.
      const last = lastChange.get(key);
      if (last) lastChange.set(keyword.adId, last);
      const merge = (stats: Map<string, AdBotStats>) => {
        const ids = [...(idsByKey.get(key) ?? [])];
        const parts = ids.map((id) => stats.get(id)).filter((row): row is AdBotStats => Boolean(row));
        if (parts.length <= 1) return;
        const sum = (field: 'impressions' | 'clicks' | 'sold' | 'revenue' | 'spend') => parts.reduce((total, row) => total + row[field], 0);
        const withPosition = parts.filter((row) => row.position !== null && row.impressions > 0);
        const position = withPosition.length
          ? withPosition.reduce((total, row) => total + (row.position as number) * row.impressions, 0) / withPosition.reduce((total, row) => total + row.impressions, 0)
          : null;
        stats.set(keyword.adId, { impressions: sum('impressions'), clicks: sum('clicks'), sold: sum('sold'), revenue: sum('revenue'), spend: sum('spend'), position });
      };
      merge(stats14);
      merge(stats7);
    }

    return { campaigns, notes, input: { keywords, stats14, stats7, groups, feed, lastChange, now } };
  }

  /** По кампании — один PUT со всеми её изменениями; после — проверка, что ставки встали. */
  private async apply(actions: AdBotAction[], campaigns: Map<string, CampaignInfo>, input: { stats14: Map<string, AdBotStats>; stats7: Map<string, AdBotStats> }, budgets?: Map<string, { weeklyAmount?: number; uniform?: boolean }>): Promise<AdBotOutcome[]> {
    const outcomes: AdBotOutcome[] = [];
    const byCampaign = new Map<string, AdBotAction[]>();
    for (const row of actions) byCampaign.set(row.campaignId, [...(byCampaign.get(row.campaignId) ?? []), row]);
    for (const [campaignId, rows] of byCampaign) {
      const campaign = campaigns.get(campaignId);
      if (!campaign) continue;
      const body = buildCampaignUpdate(campaign, rows, budgets?.get(campaignId));
      try {
        await this.cabinet.cabinet('PUT', `${CABINET}/advertising/management/ad-campaign/${campaignId}`, undefined, body);
        const isApplied = (check: Array<{ id: string; skuGroupId: string; query: string; cpm: number }>, row: AdBotAction) => {
          // Uzum при любой правке удаляет объявление и создаёт новое с НОВЫМ id
          // (04.10.2026: 39 из 39 правок). Поэтому ищем по «цвет + запрос»,
          // а не по старому id, которого после сохранения уже нет.
          const found = check.find((ad) => ad.skuGroupId === row.skuGroupId && normalizeQuery(ad.query) === normalizeQuery(row.query));
          return { found, ok: row.kind === 'SUSPEND' ? !found : Boolean(found) && found!.cpm === row.newCpm };
        };
        // Кабинет применяет PUT с задержкой: первый боевой прогон 04.10.2026
        // перечитал ставки сразу и пометил все 39 правок FAILED, хотя через
        // минуту все они стояли. FAILED не ставит кулдаун — на следующий день
        // бот поднял бы те же ставки повторно. Поэтому перечитываем до 4 раз.
        let check = await this.verify(campaignId);
        for (let attempt = 0; attempt < 3 && rows.some((row) => !isApplied(check, row).ok); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)));
          check = await this.verify(campaignId);
        }
        for (const row of rows) {
          const { found, ok } = isApplied(check, row);
          outcomes.push({ action: row, ok, message: ok ? 'готово' : 'кабинет принял запрос, но изменение не видно' });
          await this.journal([row], input, { dryRun: false, status: ok ? 'SENT' : 'FAILED', request: body, response: found ? { newAdId: found.id } : undefined, error: ok ? undefined : 'изменение не видно после сохранения' });
        }
      } catch (error: any) {
        const message = String(error?.response?.message || error?.message || error).slice(0, 300);
        for (const row of rows) outcomes.push({ action: row, ok: false, message });
        await this.journal(rows, input, { dryRun: false, status: 'FAILED', request: body, error: message, response: error?.responseBody });
      }
    }
    return outcomes;
  }

  private async verify(campaignId: string): Promise<Array<{ id: string; skuGroupId: string; query: string; cpm: number }>> {
    const result: Array<{ id: string; skuGroupId: string; query: string; cpm: number }> = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(`${CABINET}/advertising/management/ad-campaign/${campaignId}/advertisement`, { page, size: ADS_PAGE });
      const groups: any[] = Array.isArray(body?.payload?.skuGroupAdvertisements) ? body.payload.skuGroupAdvertisements : [];
      for (const group of groups) {
        for (const ad of Array.isArray(group.advertisements) ? group.advertisements : []) {
          result.push({ id: String(ad.id), skuGroupId: String(ad.skuGroupId ?? group.skuGroupId), query: String(ad.query ?? ''), cpm: Number(ad.cpm) });
        }
      }
      if (groups.length < ADS_PAGE) break;
    }
    return result;
  }

  private async journal(rows: AdBotAction[], input: { stats14: Map<string, AdBotStats>; stats7: Map<string, AdBotStats> }, extra: { dryRun: boolean; status: string; request?: unknown; response?: unknown; error?: string; adId?: string }) {
    for (const row of rows) {
      await this.prisma.adBotChange.create({
        data: {
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          skuGroupId: row.skuGroupId,
          adId: extra.adId ?? row.adId,
          query: row.query,
          action: row.kind,
          oldCpm: row.oldCpm,
          newCpm: row.newCpm,
          dryRun: extra.dryRun,
          status: extra.status,
          reason: row.reason,
          context: { stats14: row.adId ? input.stats14.get(row.adId) ?? null : null, stats7: row.adId ? input.stats7.get(row.adId) ?? null : null } as Prisma.InputJsonValue,
          request: extra.request === undefined ? undefined : (extra.request as Prisma.InputJsonValue),
          response: extra.response === undefined ? undefined : (extra.response as Prisma.InputJsonValue),
          error: extra.error,
        },
      }).catch((error: any) => this.logger.warn(`Рекламный бот: журнал не записан — ${error?.message || error}`));
    }
  }
}
