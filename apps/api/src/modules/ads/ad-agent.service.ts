import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AD_AGENT_DEFAULTS,
  adAdvice,
  AdAdvice,
  AdAgentConfig,
  AdCampaign,
  AdProduct,
  adWindows,
  buildAdAgentPrompt,
  campaignFunnelQuery,
  CPO_MEMBERS,
  cpoFunnelQuery,
  cubeUrl,
  DailyMetrics,
  formatAdReport,
  Funnel,
  FUNNEL_MEMBERS,
  isCubeContinueWait,
  parseCubeDaily,
  productFunnelQuery,
  TOP_MEMBERS,
  windowSum,
} from '../../common/ad-agent';
import { tashkentDay } from '../../common/auto-pricing';
import { DEFAULT_OPENCLAW_MODEL, OpenclawClient } from '../../common/openclaw.client';
import { IntegrationsService } from '../integrations/integrations.service';
import { PromoPricingService } from '../pricing/promo-pricing.service';

const CABINET = 'https://api-seller.uzum.uz/api/seller';

export type AdAgentResult = { today: string; advice: AdAdvice[]; products: AdProduct[]; campaigns: AdCampaign[]; aiPlan: string | null; aiNote: string | null; messages: string[] };

/**
 * Агент по рекламе: раз в день (10:00 по Ташкенту) собирает воронку товаров, «Буст заказов» и кампании
 * «Буст в ТОП» из кабинета, считает советы по правилам common/ad-agent.ts, просит Claude составить план
 * и шлёт отчёт в Telegram. Сейчас только советы — ставки и бюджеты не меняет.
 */
@Injectable()
export class AdAgentService {
  private readonly logger = new Logger(AdAgentService.name);
  private running = false;
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly cabinet: PromoPricingService,
    private readonly openclaw: OpenclawClient,
  ) {}

  @Cron(process.env.AD_AGENT_CRON || '0 10 * * *', { name: 'ad-agent', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    if (process.env.AD_AGENT_ENABLED === 'false') return;
    this.logger.log('Агент рекламы: запуск по расписанию');
    try {
      await this.run({ notify: true });
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`Агент рекламы: ${message}`);
      await this.integrations.notifyTelegram(`⚠️ Агент рекламы: запуск не выполнен — ${message}`, 'notifyAgents').catch(() => undefined);
    }
  }

  config(): AdAgentConfig {
    const maxDrr = Number(process.env.AD_AGENT_MAX_DRR_PERCENT);
    return { ...AD_AGENT_DEFAULTS, maxDrrPercent: Number.isFinite(maxDrr) && maxDrr > 0 ? maxDrr : AD_AGENT_DEFAULTS.maxDrrPercent };
  }

  async run(options: { notify: boolean }): Promise<AdAgentResult> {
    if (this.running) throw new Error('агент рекламы уже выполняется');
    this.running = true;
    try {
      const now = new Date();
      const today = tashkentDay(now);
      const cfg = this.config();
      const { products, campaigns } = await this.collect(today);
      const advice = adAdvice(products, campaigns, today, cfg);

      let aiPlan: string | null = null;
      let aiNote: string | null = null;
      if (process.env.AD_AGENT_AI !== 'false') {
        try {
          const model = process.env.AD_AGENT_AI_MODEL || DEFAULT_OPENCLAW_MODEL;
          aiPlan = (await this.openclaw.run(buildAdAgentPrompt(products, campaigns, advice, today, cfg), { model, thinking: 'low', timeoutSec: 300 })).text;
        } catch (error: any) {
          aiNote = `ИИ-план не получен (${String(error?.message || error)}) — ниже только советы правил`;
        }
      }

      const label = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now);
      const messages = formatAdReport({ label, advice, aiPlan, aiNote, products, campaigns, maxDrrPercent: cfg.maxDrrPercent });
      if (options.notify) {
        for (const text of messages) {
          if (!(await this.integrations.notifyTelegram(text, 'notifyAgents'))) {
            this.logger.warn('Агент рекламы: отчёт не отправлен — Telegram не настроен или выключено «Автоцены и реклама»');
            break;
          }
        }
      }
      this.logger.log(`Агент рекламы: товаров ${products.length}, кампаний ${campaigns.length}, советов ${advice.length}`);
      return { today, advice, products, campaigns, aiPlan, aiNote, messages };
    } finally {
      this.running = false;
    }
  }

  /** Cube отвечает «Continue wait», пока считает — повторяем до ~30 секунд. */
  private async cube(query: Record<string, unknown>, members: { id: string; day: string }): Promise<DailyMetrics> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const { body } = await this.cabinet.cabinet('GET', cubeUrl(query));
      if (!isCubeContinueWait(body)) return parseCubeDaily(body, members.id, members.day);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('Cube не посчитал данные за 30 секунд');
  }

  private async collect(today: string): Promise<{ products: AdProduct[]; campaigns: AdCampaign[] }> {
    const w = adWindows(today);

    // Товары и остатки.
    const shopId = await this.cabinet.cabinetShopId();
    const productsBody = (await this.cabinet.cabinet('GET', `${CABINET}/shop/${shopId}/product/getProducts`, { page: 0, size: 100 })).body;
    const productList: any[] = Array.isArray(productsBody?.productList) ? productsBody.productList : [];
    if (!productList.length) throw new Error('getProducts: нет товаров или неожиданная форма ответа');
    const productIds = productList.map((product) => String(product.productId));

    // «Буст заказов»: текущие ставки.
    const cpoBody = (await this.cabinet.cabinet('POST', `${CABINET}/cpo/advertisements/search`, undefined, { page: 0, size: 100, activeOnly: false, dateTo: today })).body;
    const cpoAds: any[] = Array.isArray(cpoBody?.payload?.advertisements) ? cpoBody.payload.advertisements : [];
    const sellerId = cpoAds[0]?.ownerSellerId ?? process.env.UZUM_SELLER_ID;

    // Кампании «Буст в ТОП».
    let campaignList: any[] = [];
    if (sellerId) {
      const campaignsBody = (await this.cabinet.cabinet('GET', `${CABINET}/advertising/management/ad-campaign`, { sellerId, page: 0, size: 50, from: w.from28, to: today, statusGroup: 'ALL' })).body;
      campaignList = Array.isArray(campaignsBody?.payload) ? campaignsBody.payload : [];
    }
    const liveCampaigns = campaignList.filter((row) => ['ACTIVE', 'PAUSED'].includes(String(row.status)));

    const funnel = await this.cube(productFunnelQuery(w.from28, w.to), FUNNEL_MEMBERS);
    const cpo = cpoAds.length ? await this.cube(cpoFunnelQuery(productIds, w.from7, w.to), CPO_MEMBERS) : new Map();
    const top = liveCampaigns.length ? await this.cube(campaignFunnelQuery(liveCampaigns.map((row) => String(row.id)), w.from28, w.to), TOP_MEMBERS) : new Map();

    const funnelFor = (id: string, from: string, to: string): Funnel => ({
      impressions: windowSum(funnel, id, 'sum_imps', from, to),
      views: windowSum(funnel, id, 'sum_views', from, to),
      atc: windowSum(funnel, id, 'sum_atc', from, to),
      ordered: windowSum(funnel, id, 'generated_amount', from, to),
      sold: windowSum(funnel, id, 'completed_amount', from, to),
    });

    const products: AdProduct[] = productList.map((product) => {
      const id = String(product.productId);
      const skus: any[] = Array.isArray(product.skuList) ? product.skuList : [];
      const ad = cpoAds.find((row) => String(row.productId) === id);
      return {
        productId: id,
        title: String(product.title ?? id).replace(/\s+/g, ' ').slice(0, 80),
        stockUnits: skus.reduce((sum, sku) => sum + (Number(sku.quantityActive) || 0), 0),
        avgDailySales: skus.reduce((sum, sku) => sum + (Number(sku.avgdsales) || 0), 0),
        funnel28: funnelFor(id, w.from28, w.to),
        funnel7: funnelFor(id, w.from7, w.to),
        funnelPrev7: funnelFor(id, w.fromPrev7, w.toPrev7),
        cpo: ad ? {
          status: String(ad.status),
          commission: Number(ad.commissionPercentage),
          minCommission: Number(ad.minCpoCommission),
          maxCommission: Number(ad.maxCpoCommission),
          week: {
            impressions: windowSum(cpo, id, 'impressions', w.from7, w.to),
            clicks: windowSum(cpo, id, 'clicks', w.from7, w.to),
            ordered: windowSum(cpo, id, 'ordered', w.from7, w.to),
            spend: windowSum(cpo, id, 'spendings', w.from7, w.to),
            revenue: windowSum(cpo, id, 'earnings', w.from7, w.to),
          },
        } : null,
      };
    });

    const stats = (id: string, from: string) => ({
      impressions: windowSum(top, id, 'impressions_sum', from, w.to),
      clicks: windowSum(top, id, 'clicks_sum', from, w.to),
      sold: windowSum(top, id, 'sold_quantity_sum', from, w.to),
      spend: windowSum(top, id, 'expenses_sum', from, w.to),
      revenue: windowSum(top, id, 'revenue_final', from, w.to),
    });
    const campaigns: AdCampaign[] = liveCampaigns.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? row.id),
      status: String(row.status),
      startedOn: row.period?.dateFrom ? String(row.period.dateFrom) : null,
      weeklyBudget: Number.isFinite(Number(row.budgetConfig?.weeklyAmount)) ? Number(row.budgetConfig.weeklyAmount) : null,
      week: stats(String(row.id), w.from7),
      month: stats(String(row.id), w.from28),
    }));
    return { products, campaigns };
  }
}
