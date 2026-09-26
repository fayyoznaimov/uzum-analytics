import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ADVERTISING_EXPENSE_CODES, advertisingRateTimeline, baseAdvertisingCode, ORDER_BOOST_CODE, TOP_PROMOTION_CODE } from '../../common/advertising';
import {
  adSharePercent,
  advertisingChanged,
  aggregateBuyouts,
  AUTO_PRICING_DEFAULTS,
  AUTO_RULES,
  AutoDecision,
  AutoPriceEvent,
  AutoPricingConfig,
  AutoPricingOutcome,
  AutoPricingPlan,
  AutoPricingSkuInput,
  AutoPromo,
  AutoRule,
  evaluateSku,
  formatAutoPricingReport,
  payoutRatio,
  planAutoPricingRun,
  skuRole,
  StockForecast,
  tashkentDay,
} from '../../common/auto-pricing';
import { classifyStoredOrder } from '../../common/order-state';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { LiveSku, PricingService } from './pricing.service';
import { PromoPosition, PromoPricingService } from './promo-pricing.service';

export type AutoPricingRunOptions = {
  /** Реально менять цены. Иначе — только рекомендации. */
  apply: boolean;
  /** Отправить отчёт в Telegram. */
  notify: boolean;
};

export type AutoPricingRunResult = {
  apply: boolean;
  today: string;
  plan: AutoPricingPlan;
  outcomes: AutoPricingOutcome[];
  notes: string[];
  messages: string[];
};

const DAY_MS = 86_400_000;
const envNumber = (name: string) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) ? value : null;
};

/**
 * Автоцены: два раза в сутки (09:30 и 19:30 по Ташкенту) собирает данные, решает по правилам
 * common/auto-pricing.ts и присылает отчёт в Telegram. Цены меняет только при AUTO_PRICING_APPLY=true —
 * через PricingService / PromoPricingService, со всеми их защитами и журналом PriceChange (source = auto).
 */
@Injectable()
export class AutoPricingService {
  private readonly logger = new Logger(AutoPricingService.name);
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly pricing: PricingService,
    private readonly promo: PromoPricingService,
  ) {}

  @Cron(process.env.AUTO_PRICING_CRON || '30 9,19 * * *', { name: 'auto-pricing', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    if (process.env.AUTO_PRICING_ENABLED === 'false') return;
    try {
      await this.run({ apply: process.env.AUTO_PRICING_APPLY === 'true', notify: true });
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`Автоцены: ${message}`);
      await this.integrations.notifyTelegram(`⚠️ Автоцены: запуск не выполнен — ${message}`, 'notifyErrors').catch(() => undefined);
    }
  }

  config(): AutoPricingConfig {
    const { maxStepPercent } = this.pricing.guardSettings({});
    return {
      ...AUTO_PRICING_DEFAULTS,
      maxStepPercent: Math.min(AUTO_PRICING_DEFAULTS.maxStepPercent, maxStepPercent),
      minMarginPercent: envNumber('AUTO_PRICING_MIN_MARGIN_PERCENT') ?? AUTO_PRICING_DEFAULTS.minMarginPercent,
      maxChangesPerRun: Math.max(0, Math.trunc(envNumber('AUTO_PRICING_MAX_CHANGES') ?? AUTO_PRICING_DEFAULTS.maxChangesPerRun)),
    };
  }

  async run(options: AutoPricingRunOptions): Promise<AutoPricingRunResult> {
    if (this.running) throw new Error('автоцены уже выполняются');
    this.running = true;
    try {
      const now = new Date();
      const today = tashkentDay(now);
      const cfg = this.config();
      const { inputs, notes } = await this.collect(now, today);
      const plan = planAutoPricingRun(inputs.map((input) => evaluateSku(input, today, cfg)), cfg);
      const outcomes = options.apply ? await this.applyChanges(plan.changes, inputs) : [];

      const label = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now);
      const messages = formatAutoPricingReport(plan, {
        apply: options.apply, label, stockNote: notes.length ? notes.join('; ') : null, outcomes, maxChangesPerRun: cfg.maxChangesPerRun,
      });
      if (options.notify) {
        for (const text of messages) await this.integrations.notifyTelegram(text, 'notifyDailyDigest');
      }
      this.logger.log(`Автоцены (${options.apply ? 'изменение' : 'рекомендации'}): изменений ${plan.changes.length}, отложено ${plan.deferred.length}, вручную ${plan.recommendations.length}, без изменений ${plan.holds.length}, пропущено ${plan.skips.length}`);
      return { apply: options.apply, today, plan, outcomes, notes, messages };
    } finally {
      this.running = false;
    }
  }

  /** Входные данные по всем SKU магазина. Сбой необязательных источников — заметка в отчёте, а не отказ. */
  private async collect(now: Date, today: string): Promise<{ inputs: AutoPricingSkuInput[]; notes: string[] }> {
    const notes: string[] = [];
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new Error('нет активного магазина');
    const since = (days: number) => new Date(now.getTime() - days * DAY_MS);

    const live = await this.pricing.liveSkus(shop.externalId);

    let positions: PromoPosition[] = [];
    try {
      positions = (await this.promo.promoPrices()).positions;
    } catch (error: any) {
      notes.push(`Акции из кабинета не получены (${error?.message || error}) — SKU в акциях только в рекомендациях`);
    }
    const promosBySku = new Map<string, AutoPromo[]>();
    for (const row of positions) {
      const list = promosBySku.get(String(row.skuId)) ?? [];
      list.push({ saleId: row.saleId, saleTitle: row.saleTitle, status: row.saleStatus, salePrice: row.salePrice, maxPrice: row.maxPrice, basePrice: row.basePrice });
      promosBySku.set(String(row.skuId), list);
    }

    const forecasts = new Map<string, StockForecast>();
    try {
      for (const row of (await this.promo.cabinetStock(now)).forecasts) forecasts.set(row.skuId, row);
    } catch (error: any) {
      notes.push(`Запас из кабинета не получен (${error?.message || error}) — правила дефицита не применялись`);
    }

    const skus = await this.prisma.sku.findMany({
      where: { product: { shopId: shop.id } },
      include: { product: { select: { externalId: true, title: true } }, costs: { where: { validTo: null }, orderBy: { validFrom: 'desc' }, take: 1 } },
    });

    const orders = await this.prisma.order.findMany({
      where: { shopId: shop.id, issuedAt: { gte: since(90) } },
      select: {
        status: true, state: true, paidAt: true, issuedAt: true, returnedUnits: true, payout: true, payoutReported: true, grossRevenue: true,
        items: { select: { skuId: true, quantity: true, returns: true, amount: true, marketplaceProductId: true, sku: { select: { product: { select: { externalId: true } } } } } },
      },
    });
    const buyouts = aggregateBuyouts(orders.map((order: any) => ({
      state: classifyStoredOrder({
        status: order.status, state: order.state, paidAt: order.paidAt,
        amount: order.items.reduce((sum: number, item: any) => sum + item.quantity, 0), amountReturns: order.returnedUnits,
      }),
      issuedAt: order.issuedAt,
      payout: Number(order.payout),
      payoutReported: Boolean(order.payoutReported),
      gross: Number(order.grossRevenue),
      items: order.items.map((item: any) => ({
        skuId: item.skuId, productId: item.sku?.product.externalId || item.marketplaceProductId || null,
        quantity: item.quantity, returns: item.returns, amount: Number(item.amount),
      })),
    })));
    const shopPayoutRatio = payoutRatio(buyouts.shop);

    // Реклама: фактический расход за 90 дней (доля в выручке), ставки У000120 и расход У000119 — для «менялась ли реклама».
    const expenses = await this.prisma.marketplaceExpense.findMany({
      where: { shopId: shop.id, code: { in: [...ADVERTISING_EXPENSE_CODES] }, productExternalId: { not: null }, serviceAt: { gte: since(90) } },
      select: { id: true, code: true, type: true, amount: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
    });
    const adSpend = new Map<string, number>();
    const topSpend = new Map<string, Record<string, number>>();
    for (const row of expenses as any[]) {
      const productId = String(row.productExternalId);
      adSpend.set(productId, (adSpend.get(productId) ?? 0) + Number(row.amount));
      if (baseAdvertisingCode(row.code) === TOP_PROMOTION_CODE) {
        const byDay = topSpend.get(productId) ?? {};
        const day = tashkentDay(row.serviceAt);
        byDay[day] = (byDay[day] ?? 0) + Number(row.amount);
        topSpend.set(productId, byDay);
      }
    }
    const rates = advertisingRateTimeline((expenses as any[]).filter((row) => row.code === ORDER_BOOST_CODE && row.type === 'OUTCOME' && row.serviceAt >= since(30)));

    const changes = await this.prisma.priceChange.findMany({
      where: { shopExternalId: shop.externalId, status: 'SENT', dryRun: false, createdAt: { gte: since(45) } },
      orderBy: { createdAt: 'desc' },
    });
    const history = new Map<string, AutoPriceEvent[]>();
    for (const row of changes as any[]) {
      const list = history.get(row.skuExternalId) ?? [];
      list.push({
        at: row.createdAt,
        kind: row.kind === 'PROMO' ? 'PROMO' : 'BASE',
        oldPrice: row.oldPrice ?? null,
        newPrice: row.verifiedPrice ?? row.newPrice,
        rule: AUTO_RULES.includes(row.rule) ? (row.rule as AutoRule) : null,
        stock: Number.isFinite(Number(row.context?.stock)) ? Number(row.context.stock) : null,
        saleId: Number.isFinite(Number(row.request?.saleId)) ? Number(row.request.saleId) : null,
      });
      history.set(row.skuExternalId, list);
    }

    const settings = await this.prisma.financialSettings.findUnique({ where: { shopId: shop.id } });
    const taxPercent = settings ? Number(settings.taxPercent) : 1;
    const { minPrice } = this.pricing.guardSettings({});
    const extraLocomotives = String(process.env.AUTO_PRICING_LOCOMOTIVES || '').split(',').map((value) => value.trim()).filter(Boolean);

    const inputs = skus.map((sku: any): AutoPricingSkuInput => {
      const skuId = String(sku.externalId);
      const productId = String(sku.product.externalId);
      const liveSku: LiveSku | undefined = live.get(skuId);
      const cost = sku.costs[0];
      const unitCost = cost ? Number(cost.amount) + Number(cost.packagingCost) + Number(cost.additionalCost) + Number(cost.warehouseLogisticsCost) : null;
      const forecast = forecasts.get(skuId) ?? null;
      const productMoney = buyouts.products.get(productId);
      return {
        skuId,
        productId,
        title: sku.sellerSku || liveSku?.title || sku.product.title,
        role: skuRole(sku.sellerSku, skuId, extraLocomotives),
        basePrice: liveSku?.price ?? null,
        inOffer: Boolean(liveSku?.inPromo),
        promos: promosBySku.get(skuId) ?? [],
        stock: forecast?.quantity ?? sku.stock,
        costAmount: cost ? Number(cost.amount) : null,
        unitCost: unitCost && unitCost > 0 ? unitCost : null,
        forecast,
        buyouts: buyouts.bySku.get(sku.id) ?? {},
        payoutRatio: payoutRatio(productMoney) ?? shopPayoutRatio,
        adPercent: adSharePercent(adSpend.get(productId) ?? 0, productMoney),
        taxPercent,
        adChange: advertisingChanged({ rates: rates.get(productId) ?? [], topSpendByDay: topSpend.get(productId) ?? {} }, today),
        history: history.get(skuId) ?? [],
        minPrice,
        unavailable: !liveSku ? 'не найден в Uzum' : liveSku.archived ? 'в архиве Uzum' : liveSku.blocked ? 'заблокирован в Uzum' : null,
      };
    });
    return { inputs, notes };
  }

  /** Отправка изменений по одному, со всеми защитами PricingService / PromoPricingService. */
  private async applyChanges(changes: AutoDecision[], inputs: AutoPricingSkuInput[]): Promise<AutoPricingOutcome[]> {
    const bySku = new Map(inputs.map((input) => [input.skuId, input]));
    const outcomes: AutoPricingOutcome[] = [];
    for (const row of changes) {
      if (row.newPrice === null || row.rule === null) continue;
      const input = bySku.get(row.skuId);
      const context = { role: row.role, stock: input?.stock ?? null, ...row.metrics };
      const common = { dryRun: false, source: 'auto', reason: row.reason, rule: row.rule, context, maxStepPercent: this.config().maxStepPercent };
      try {
        const result: any = row.kind === 'PROMO'
          ? await this.promo.sendPromoPrice(row.skuId, row.newPrice, { ...common, saleId: row.saleId ?? undefined })
          : await this.pricing.sendPrice(row.skuId, row.newPrice, common);
        outcomes.push(result.sent
          ? { skuId: row.skuId, ok: true, message: `Uzum показывает ${result.verifiedPrice ?? 'нет данных'}${result.stillInSale === false ? ', SKU пропал из акции!' : ''}` }
          : { skuId: row.skuId, ok: false, message: `отказ защиты: ${(result.violations || []).map((v: any) => v.message).join('; ')}` });
      } catch (error: any) {
        outcomes.push({ skuId: row.skuId, ok: false, message: String(error?.response?.message || error?.message || error) });
      }
    }
    return outcomes;
  }
}
