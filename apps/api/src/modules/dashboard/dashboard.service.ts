import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ADVERTISING_EXPENSE_CODES,
  advertisingEstimateAt,
  advertisingRateTimeline,
  baseAdvertisingCode,
  latestAdvertisingRates,
  ORDER_BOOST_CODE,
  TOP_PROMOTION_CODE,
} from '../../common/advertising';
import { CostBreakdown, calculateOrderFinancials } from '../../common/finance';
import { classifyStoredOrder } from '../../common/order-state';
import { basketEligibleDate, buildWithdrawalBasket } from '../../common/payout-basket';
import { PeriodQuery, resolvePeriod, tashkentHour, tashkentKey } from '../../common/period';
import { PrismaService } from '../../common/prisma.service';
import { buildProfitDays } from '../../common/profit-days';
import { GoalsService } from '../goals/goals.service';

type OrderWithItems = Prisma.OrderGetPayload<{
  include: { items: { include: { sku: { include: { product: true; costs: true } } } } };
}>;

type FinancialRow = ReturnType<typeof calculateOrderFinancials> & { order: OrderWithItems };

const DAY_MS = 86_400_000;
const ADVERTISING_RATE_MAX_AGE_DAYS = 30;
// Uzum posts U000120 after the advertised order is shown (normally after
// fulfilment). Live data currently contains lags up to 84 days, so keep a
// bounded 90-day publication window while dating the rate by Namoyish.
const ADVERTISING_RATE_PUBLICATION_LAG_DAYS = 90;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(forwardRef(() => GoalsService)) private readonly goalsService?: GoalsService,
  ) {}

  private state(order: OrderWithItems) {
    return classifyStoredOrder({
      status: order.status,
      state: order.state,
      paidAt: order.paidAt,
      amount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      amountReturns: order.returnedUnits,
    });
  }

  private async loadOrders(shopId: string, from: Date, to: Date) {
    return this.prisma.order.findMany({
      where: { shopId, issuedAt: { gte: from, lte: to } },
      include: {
        items: {
          include: {
            sku: { include: { product: true, costs: { orderBy: { validFrom: 'desc' } } } },
          },
        },
      },
      orderBy: { dateIssued: 'asc' },
    });
  }

  private async loadWalletOrders(shopId: string, from: Date, to: Date) {
    return this.prisma.order.findMany({
      where: {
        shopId,
        OR: [
          { dateIssued: { gte: from, lte: to } },
          { issuedAt: { gte: from, lte: to } },
        ],
      },
      include: {
        items: {
          include: {
            sku: { include: { product: true, costs: { orderBy: { validFrom: 'desc' } } } },
          },
        },
      },
      orderBy: { dateIssued: 'asc' },
    });
  }

  private async loadOrderedOrders(shopId: string, from: Date, to: Date) {
    return this.prisma.order.findMany({
      where: { shopId, orderedAt: { gte: from, lte: to } },
      include: { items: { include: { sku: { include: { product: true, costs: { orderBy: { validFrom: 'desc' } } } } } } },
      orderBy: { orderedAt: 'asc' },
    });
  }

  private loadProductAdvertisingExpenses(shopId: string, from: Date, to: Date, now = new Date()) {
    const serviceFrom = new Date(from.getTime() - ADVERTISING_RATE_MAX_AGE_DAYS * DAY_MS);
    const serviceTo = new Date(Math.min(
      now.getTime(),
      to.getTime() + ADVERTISING_RATE_PUBLICATION_LAG_DAYS * DAY_MS,
    ));
    return this.prisma.marketplaceExpense.findMany({
      where: {
        shopId,
        code: ORDER_BOOST_CODE,
        type: 'OUTCOME',
        productExternalId: { not: null },
        serviceAt: { gte: serviceFrom, lte: serviceTo },
      },
      select: { id: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
    });
  }

  private costPartsAtDate(item: OrderWithItems['items'][number], date: Date): CostBreakdown {
    const costs = item.sku?.costs || [];
    // Cost corrections entered after a sale must backfill that sale; otherwise a
    // stale historical zero makes today's profit look artificially high.
    const row = costs.find((cost) => !cost.validTo) || costs[0];
    if (!row) return { productCost: 0, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0 };
    return {
      productCost: Number(row.amount) * item.quantity,
      packagingCost: Number(row.packagingCost) * item.quantity,
      warehouseLogisticsCost: Number(row.warehouseLogisticsCost) * item.quantity,
      additionalCost: Number(row.additionalCost) * item.quantity,
    };
  }

  private financials(order: OrderWithItems, taxPercent: number, advertisingPercent: number, fallbackCommissionPercent: number) {
    const costs = order.items.reduce((sum: CostBreakdown, item: OrderWithItems['items'][number]) => {
      const part = this.costPartsAtDate(item, order.dateIssued);
      sum.productCost += part.productCost;
      sum.packagingCost += part.packagingCost;
      sum.warehouseLogisticsCost += part.warehouseLogisticsCost;
      sum.additionalCost += part.additionalCost;
      return sum;
    }, { productCost: 0, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0 });

    const calculated = calculateOrderFinancials({
      gross: Number(order.grossRevenue),
      payout: Number(order.payout),
      commission: Number(order.commission),
      marketplaceLogistics: Number(order.logistics),
      payoutReported: order.payoutReported,
      commissionReported: order.commissionReported,
      logisticsReported: order.logisticsReported,
      taxPercent,
      advertisingPercent,
      fallbackCommissionPercent,
      ...costs,
    });
    const actualAdvertising = order.adCostReported ? Number(order.adCost) : calculated.advertising;
    const base = { ...calculated, advertising: actualAdvertising, profit: calculated.profit + calculated.advertising - actualAdvertising };

    const orderedUnits = Math.max(1, this.units([order]));
    const returnedUnits = Math.min(orderedUnits, Math.max(0, order.returnedUnits || 0));
    if (!returnedUnits) return base;
    const ratio = Math.max(0, (orderedUnits - returnedUnits) / orderedUnits);
    // Uzum's reported payout/commission/logistics already reflect returns. Only
    // unit-based revenue and internal costs need to be reduced here. Prorating
    // the reported payout again made a partial return smaller a second time.
    const gross = base.gross * ratio;
    const payout = base.payout;
    const commission = order.commissionReported ? base.commission : base.commission * ratio;
    const marketplaceLogistics = order.logisticsReported ? base.marketplaceLogistics : base.marketplaceLogistics * ratio;
    const productCost = base.productCost * ratio;
    const packagingCost = base.packagingCost * ratio;
    const warehouseLogisticsCost = base.warehouseLogisticsCost * ratio;
    const additionalCost = base.additionalCost * ratio;
    const internalCosts = productCost + packagingCost + warehouseLogisticsCost + additionalCost;
    const tax = gross * taxPercent / 100;
    const advertising = order.adCostReported ? base.advertising : base.advertising * ratio;
    const profit = payout - internalCosts - tax - advertising;
    const payoutCalculated = gross - commission - marketplaceLogistics;
    const payoutDifference = payout - payoutCalculated;
    return {
      ...base,
      gross,
      payout,
      payoutCalculated,
      payoutDifference,
      commission,
      marketplaceLogistics,
      productCost,
      packagingCost,
      warehouseLogisticsCost,
      additionalCost,
      internalCosts,
      tax,
      advertising,
      profit,
      returnReserve: Math.max(0, Number(order.returnAmount || 0)),
      marketplaceWithheld: gross - payout,
      otherMarketplaceDeductions: Math.max(0, gross - commission - marketplaceLogistics - payout),
      marginPercent: gross > 0 ? profit / gross * 100 : 0,
    };
  }

  private delta(current: number, previous: number) {
    if (!previous) return current ? 100 : 0;
    return (current - previous) / Math.abs(previous) * 100;
  }

  private uniqueOrderCount(orders: OrderWithItems[]) {
    return new Set(orders.map((order) => order.marketplaceOrderId || order.externalId)).size;
  }

  private units(orders: OrderWithItems[]) {
    return orders.reduce((sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  }

  private remainingPayout(order: OrderWithItems, payout: number) {
    if (order.statementImportedAt) {
      return Math.max(0, payout - Number(order.withdrawnAmount || 0));
    }
    const apiWithdrawn = Number(order.apiWithdrawnAmount || 0);
    if (Number.isFinite(apiWithdrawn) && apiWithdrawn > 0) {
      return Math.max(0, payout - apiWithdrawn);
    }
    const raw = order.raw && typeof order.raw === 'object' && !Array.isArray(order.raw)
      ? order.raw as Record<string, unknown>
      : {};
    const withdrawn = Number(raw.withdrawnProfit ?? 0);
    return Math.max(0, payout - (Number.isFinite(withdrawn) ? withdrawn : 0));
  }

  private sum(rows: FinancialRow[], key: keyof Omit<FinancialRow, 'order'>) {
    return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  }

  /**
   * Кэш главного экрана.
   *
   * Сам расчёт — это ~250 запросов на 0,8 с в базе и ещё около 6 с чистого JS:
   * Prisma материализует десятки тысяч объектов, дальше по ним идут вложенные
   * циклы. Переписывать расчёт — отдельная работа, а пока цифры всё равно
   * меняются только после синхронизации (раз в 30 минут), поэтому повторные
   * открытия отдаём из памяти.
   *
   * Ключ кэша — параметры периода, отпечаток — момент последней успешной
   * синхронизации: пришли новые данные, значит кэш сразу невалиден. TTL нужен
   * сверх этого потому, что часть чисел (прогнозы, «сегодня») зависит от
   * текущего времени, а не только от данных.
   */
  private readonly overviewCache = new Map<string, { computedAt: number; stamp: string; data: unknown }>();
  private static readonly OVERVIEW_CACHE_TTL_MS = 5 * 60_000;

  async overview(query: PeriodQuery = {}) {
    const key = JSON.stringify(query ?? {});
    const stamp = await this.dataStamp();
    const cached = this.overviewCache.get(key);
    if (cached && cached.stamp === stamp && Date.now() - cached.computedAt < DashboardService.OVERVIEW_CACHE_TTL_MS) {
      return cached.data;
    }
    const data = await this.computeOverview(query);
    this.overviewCache.set(key, { computedAt: Date.now(), stamp, data });
    return data;
  }

  /** Отпечаток состояния данных: последняя успешная синхронизация. */
  private async dataStamp() {
    const last = await this.prisma.syncRun.findFirst({
      where: { status: 'SUCCESS' },
      orderBy: { finishedAt: 'desc' },
      select: { id: true, finishedAt: true },
    });
    return `${last?.id ?? 'none'}:${last?.finishedAt?.getTime() ?? 0}`;
  }

  private async computeOverview(query: PeriodQuery = {}) {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return { empty: true };
    const period = resolvePeriod(query);
    const { from, to, prevFrom, prevTo, days } = period;

    const [orders, previous, orderedOrders, fulfillmentExpenses, goals, products, skus, settings, supplyCount, latestInventory, previousTopExpenses] = await Promise.all([
      this.loadOrders(shop.id, from, to),
      period.compare ? this.loadOrders(shop.id, prevFrom, prevTo) : Promise.resolve([] as OrderWithItems[]),
      this.loadOrderedOrders(shop.id, from, to),
      this.prisma.marketplaceExpense.findMany({
        where: {
          shopId: shop.id,
          serviceAt: { gte: from, lte: to },
          OR: [
            { code: { startsWith: 'logistics-' }, type: 'OUTCOME' },
            { code: { startsWith: 'return-logistics-' }, type: 'INCOME' },
          ],
        },
      }),
      this.goalsService
        ? this.goalsService.list().then((rows) => rows.filter((goal) => goal.shopId === shop.id && goal.startAt <= to && goal.endAt >= from))
        : this.prisma.goal.findMany({ where: { shopId: shop.id, startAt: { lte: to }, endAt: { gte: from } } }),
      this.prisma.product.count({ where: { shopId: shop.id } }),
      this.prisma.sku.findMany({
        where: { product: { shopId: shop.id } },
        include: { product: true, costs: { where: { validTo: null }, orderBy: { validFrom: 'desc' }, take: 1 } },
      }),
      this.prisma.financialSettings.upsert({
        where: { shopId: shop.id },
        update: {},
        create: { shopId: shop.id, taxPercent: 1, advertisingPercent: 0, marketplaceCommissionFallbackPercent: 0, payoutDelayDays: 10, payoutSchedule: 'BIWEEKLY', payoutServiceFeePercent: 0, urgentWithdrawalFeePercent: 2.5 },
      }),
      this.prisma.supply.count({ where: { shopId: shop.id } }),
      this.prisma.inventoryReportImport.findFirst({
        where: { shopId: shop.id },
        orderBy: { importedAt: 'desc' },
        include: { metrics: { include: { sku: { include: { product: true, costs: { where: { validTo: null }, take: 1 } } } } } },
      }),
      period.compare ? this.prisma.marketplaceExpense.findMany({ where: { shopId: shop.id, code: { in: [TOP_PROMOTION_CODE, `return-${TOP_PROMOTION_CODE}`] }, serviceAt: { gte: prevFrom, lte: prevTo } } }) : Promise.resolve([]),
    ]);

    // serviceAt is already the day when the service/campaign ran. createdAt can
    // arrive later, but shifting serviceAt corrupts daily and period totals.
    const advertisingFrom = from;
    const advertisingTo = to;
    const topAdvertisingFrom = from;
    const topAdvertisingTo = to;
    const todayKey = tashkentKey(new Date());
    const todayPeriod = resolvePeriod({ from: todayKey, to: todayKey, compare: false });
    const advertisingRateNow = new Date(Math.min(Date.now(), to.getTime()));
    const [balanceOrders, balanceExpenses, periodOrderBoostExpenses, periodTopExpenses, previousOrderBoostExpenses, latestFinancialStatement, recentProductAdvertisingExpenses, periodAllExpenses] = await Promise.all([
      // Баланс считается по всей истории заказов, но из неё нужны только деньги
      // (см. paidBalanceOrders ниже) — ни позиции, ни SKU, ни версии себестоимости
      // здесь не читаются. Полный include тянул каждый заказ со всеми товарами и
      // всеми версиями SkuCost и один давал больше 10 секунд на главном экране.
      this.prisma.order.findMany({
        where: { shopId: shop.id, issuedAt: { lte: to } },
        select: {
          status: true, issuedAt: true, payout: true,
          statementImportedAt: true, withdrawnAmount: true, apiWithdrawnAmount: true, raw: true,
        },
      }),
      // Здесь читаются только amount/code/name — raw не нужен, а он самый тяжёлый.
      this.prisma.marketplaceExpense.findMany({
        where: {
          shopId: shop.id,
          serviceAt: { lte: to },
        },
        select: { amount: true, code: true, name: true },
      }),
      this.prisma.marketplaceExpense.findMany({
        where: { shopId: shop.id, code: { in: [ORDER_BOOST_CODE, `return-${ORDER_BOOST_CODE}`] }, serviceAt: { gte: advertisingFrom, lte: advertisingTo } },
      }),
      this.prisma.marketplaceExpense.findMany({
        where: { shopId: shop.id, code: { in: [TOP_PROMOTION_CODE, `return-${TOP_PROMOTION_CODE}`] }, serviceAt: { gte: topAdvertisingFrom, lte: topAdvertisingTo } },
      }),
      period.compare ? this.prisma.marketplaceExpense.findMany({
        where: { shopId: shop.id, code: { in: [ORDER_BOOST_CODE, `return-${ORDER_BOOST_CODE}`] }, serviceAt: { gte: prevFrom, lte: prevTo } },
      }) : Promise.resolve([]),
      this.prisma.financialStatementImport.findFirst({
        where: { shopId: shop.id },
        orderBy: { importedAt: 'desc' },
        select: { reportAsOf: true, summary: true },
      }),
      this.loadProductAdvertisingExpenses(shop.id, from, to),
      // Полный ledger finance/expenses за период — чтобы найти сборы Uzum, которые
      // не входят ни в рекламу, ни в логистику заказа/поставки (хранение на складе,
      // штрафы приёмки, доп. услуги) и сейчас нигде не вычитаются из прибыли.
      this.prisma.marketplaceExpense.findMany({
        where: { shopId: shop.id, serviceAt: { gte: from, lte: to } },
        select: { code: true, name: true, type: true, amount: true, serviceAt: true },
      }),
    ]);

    // Коды, уже учтённые в другом месте расчёта — не дублируем их здесь:
    // logistics-*/return-logistics-* — в order.logistics/marketplaceLogistics и в issuedTodayUnits;
    // У000120/У000119 (и их return-) — в orderBoostExpense/topPromotionExpense;
    // У000101 — авто-заполняет Supply.logisticsCost -> warehouseLogisticsCost (см. supplies.service.ts).
    // BALANCE_CORRECTION — перераспределение баланса между магазинами продавца,
    // не расход; показываем отдельно как аномалию, а не вычитаем из прибыли.
    let otherMarketplaceFeesExpense = 0;
    let balanceCorrectionAnomaly = 0;
    const otherFeeBreakdownMap = new Map<string, { code: string; label: string; amount: number; count: number }>();
    const dayOtherFees: Array<{ date: Date; amount: number }> = [];
    for (const expense of periodAllExpenses) {
      const code = baseAdvertisingCode(expense.code);
      if (code === ORDER_BOOST_CODE || code === TOP_PROMOTION_CODE) continue;
      if (/^logistics-/.test(code)) continue;
      if (code === 'У000101') continue;
      const amount = Number(expense.amount);
      if (code === 'BALANCE_CORRECTION') { balanceCorrectionAnomaly += amount; continue; }
      otherMarketplaceFeesExpense += amount;
      dayOtherFees.push({ date: expense.serviceAt, amount });
      const row = otherFeeBreakdownMap.get(code) || { code, label: expense.name || code, amount: 0, count: 0 };
      row.amount += amount;
      row.count += 1;
      otherFeeBreakdownMap.set(code, row);
    }
    const otherFeeBreakdown = [...otherFeeBreakdownMap.values()].sort((a, b) => b.amount - a.amount);

    const taxPercent = Number(settings.taxPercent);
    const productAdvertisingTimeline = advertisingRateTimeline(recentProductAdvertisingExpenses);
    const productAdvertisingRates = latestAdvertisingRates(recentProductAdvertisingExpenses, { now: advertisingRateNow });
    const fallbackCommissionPercent = Number(settings.marketplaceCommissionFallbackPercent);
    const payoutDelayDays = Number(settings.payoutDelayDays ?? 10);
    const payoutSchedule = String((settings as any).payoutSchedule || 'BIWEEKLY');
    const payoutServiceFeePercent = Number((settings as any).payoutServiceFeePercent ?? 0);
    const urgentWithdrawalFeePercent = Number((settings as any).urgentWithdrawalFeePercent ?? 2.5);

    const groups = { PAID: [] as OrderWithItems[], WAITING: [] as OrderWithItems[], OTHER: [] as OrderWithItems[], RETURNED: [] as OrderWithItems[], CANCELED: [] as OrderWithItems[] };
    for (const order of orders) groups[this.state(order)].push(order);
    const paid = groups.PAID;
    const orderedGroups = { PAID: [] as OrderWithItems[], WAITING: [] as OrderWithItems[], OTHER: [] as OrderWithItems[], RETURNED: [] as OrderWithItems[], CANCELED: [] as OrderWithItems[] };
    for (const order of orderedOrders) orderedGroups[this.state(order)].push(order);
    const waiting = orderedGroups.WAITING;
    const otherActive = orderedGroups.OTHER;
    const orderedActiveOrders = [...orderedGroups.PAID, ...orderedGroups.WAITING, ...orderedGroups.OTHER];
    // Заказы, которые покупатель не выкупил дольше 7 полных дней с даты заказа.
    // На 8-й день Uzum обычно снимает бронь/отменяет такой заказ — это деньги
    // под риском возврата, независимо от выбранного периода на экране.
    const staleWaitingCutoffDays = 7;
    const staleWaitingCutoff = new Date(Date.now() - staleWaitingCutoffDays * DAY_MS);
    const staleWaitingWindowStart = new Date(Date.now() - 60 * DAY_MS);
    const staleWaitingCandidates = await this.prisma.order.findMany({
      where: {
        shopId: shop.id,
        issuedAt: null,
        orderedAt: { gte: staleWaitingWindowStart, lte: staleWaitingCutoff },
      },
      include: { items: { include: { sku: { include: { product: true } } } } },
      orderBy: { orderedAt: 'asc' },
      take: 300,
    });
    const staleWaitingRows = staleWaitingCandidates
      .filter((order) => this.state(order) === 'WAITING' && order.orderedAt)
      .map((order) => ({
        id: order.id,
        marketplaceOrderId: order.marketplaceOrderId,
        externalId: order.externalId,
        orderedAt: order.orderedAt,
        daysWaiting: Math.floor((Date.now() - order.orderedAt!.getTime()) / DAY_MS),
        units: this.units([order]),
        amount: Number(order.grossRevenue),
        title: order.items[0]?.title || 'Товар',
        sellerSku: order.items[0]?.sku?.sellerSku || null,
      }))
      .sort((a, b) => b.daysWaiting - a.daysWaiting);
    const staleWaitingOrders = {
      cutoffDays: staleWaitingCutoffDays,
      count: staleWaitingRows.length,
      units: staleWaitingRows.reduce((sum, row) => sum + row.units, 0),
      amount: staleWaitingRows.reduce((sum, row) => sum + row.amount, 0),
      orders: staleWaitingRows.slice(0, 20),
      note: `Заказан(ы), но не выданы покупателю дольше ${staleWaitingCutoffDays} дней. По опыту Uzum на 8-й день такие заказы обычно снимаются с брони — это не факт возврата, а список для проверки.`,
    };
    const yesterdayKey = tashkentKey(new Date(todayPeriod.from.getTime() - 86_400_000));
    const recentPeriodKeys = [yesterdayKey, todayKey].filter((key) => period.fromDate <= key && period.toDate >= key);
    // Uzum списывает рекламу за день на следующий день. «Свежим» (реклама может
    // быть ещё неполной) держим сегодня всегда, а вчера — только пока по нему не
    // пришло ни одной фактической строки рекламного ledger (У000120/У000119).
    // Как только за вчера появились реальные списания — день финален, и профит
    // по нему больше не прячется под меткой «на сейчас».
    const advertisingSettledDays = new Set<string>();
    for (const expense of [...periodOrderBoostExpenses, ...periodTopExpenses]) {
      if (Number(expense.amount) > 0) advertisingSettledDays.add(tashkentKey(expense.serviceAt));
    }
    const freshPeriodKeys = recentPeriodKeys.filter((key) => key === todayKey || !advertisingSettledDays.has(key));
    const confirmedOrderBoostExpense = periodOrderBoostExpenses.reduce((sum, item) => sum + Number(item.amount), 0);
    const confirmedTopPromotionExpense = periodTopExpenses.reduce((sum, item) => sum + Number(item.amount), 0);
    const calculatedFinancialRows: FinancialRow[] = paid.map((order) => ({ order, ...this.financials(order, taxPercent, 0, fallbackCommissionPercent) }));
    const realizedPayoutPendingOrders = paid.filter((order) => !order.payoutReported).length;
    const realizedItemsNeedingCost = paid.flatMap((order) => order.items).filter((item) => (
      Math.max(0, item.quantity - Math.max(0, item.returns)) > 0
    ));
    const realizedMissingCostItems = realizedItemsNeedingCost.filter((item) => !item.sku?.costs?.length).length;
    // Список того, что именно мешает посчитать прибыль, чтобы экран показывал
    // конкретный to-do вместо безликого «нет исходных данных».
    const realizedMissingCostSkus = [...new Set(
      realizedItemsNeedingCost
        .filter((item) => !item.sku?.costs?.length)
        .map((item) => item.sku?.sellerSku || item.externalId || item.title || 'Без SKU'),
    )].slice(0, 20);
    const realizedPayoutPendingOrderRefs = [...new Set(
      paid.filter((order) => !order.payoutReported).map((order) => order.marketplaceOrderId || order.externalId),
    )].slice(0, 20);
    const realizedCostCoverage = realizedItemsNeedingCost.length
      ? (realizedItemsNeedingCost.length - realizedMissingCostItems) / realizedItemsNeedingCost.length * 100
      : 100;
    const realizedPayoutCoverage = paid.length
      ? (paid.length - realizedPayoutPendingOrders) / paid.length * 100
      : 100;
    const financialRevenue = this.sum(calculatedFinancialRows, 'gross');
    const linkedOrderBoostByOrderId = new Map<string, number>();
    const unallocatedConfirmedOrderBoostByDay = new Map<string, number>();
    const addUnallocatedConfirmed = (expense: typeof periodOrderBoostExpenses[number]) => {
      if (Number(expense.amount) <= 0) return;
      const day = tashkentKey(expense.serviceAt);
      unallocatedConfirmedOrderBoostByDay.set(day, (unallocatedConfirmedOrderBoostByDay.get(day) ?? 0) + Number(expense.amount));
    };
    for (const expense of periodOrderBoostExpenses) {
      const key = String(expense.orderExternalId || '');
      if (!key) { addUnallocatedConfirmed(expense); continue; }
      const rowMatchesExpenseProduct = (row: FinancialRow) => !expense.productExternalId || row.order.items.some((item) => (
        item.sku?.product.externalId || item.marketplaceProductId
      ) === expense.productExternalId);
      const exactRows = calculatedFinancialRows.filter((row) => row.order.externalId === key);
      const exact = exactRows.filter(rowMatchesExpenseProduct);
      const parent = exactRows.length ? [] : calculatedFinancialRows.filter((row) => row.order.marketplaceOrderId === key);
      const candidates = exactRows.length
        ? exact
        : expense.productExternalId
          ? parent.filter(rowMatchesExpenseProduct)
          : parent;
      if (!candidates.length) { addUnallocatedConfirmed(expense); continue; }
      const candidateRevenue = candidates.reduce((sum, row) => sum + row.gross, 0);
      for (const candidate of candidates) {
        const share = candidateRevenue > 0 ? candidate.gross / candidateRevenue : 1 / candidates.length;
        linkedOrderBoostByOrderId.set(
          candidate.order.id,
          (linkedOrderBoostByOrderId.get(candidate.order.id) ?? 0) + Number(expense.amount) * share,
        );
      }
    }
    const provisionalOrderBoostByOrderId = new Map<string, number>();
    let provisionalCoveredRevenue = 0;
    let provisionalCandidateRevenue = 0;
    const provisionalCandidates: Array<{ orderId: string; day: string; amount: number }> = [];
    for (const row of calculatedFinancialRows) {
      const dateKey = tashkentKey(row.order.issuedAt || row.order.dateIssued);
      if (!freshPeriodKeys.includes(dateKey) || linkedOrderBoostByOrderId.has(row.order.id)) continue;
      const estimate = advertisingEstimateAt(row.order.items.map((item) => ({
        amount: Number(item.amount) * (item.quantity > 0
          ? Math.max(0, item.quantity - Math.max(0, item.returns)) / item.quantity
          : 0),
        productExternalId: item.sku?.product.externalId || item.marketplaceProductId || null,
      })), productAdvertisingTimeline, row.order.orderedAt || row.order.issuedAt || row.order.dateIssued, {
        maxRateAgeDays: ADVERTISING_RATE_MAX_AGE_DAYS,
      });
      provisionalCoveredRevenue += estimate.coveredRevenue;
      provisionalCandidateRevenue += estimate.totalRevenue;
      if (estimate.amount > 0) provisionalCandidates.push({ orderId: row.order.id, day: dateKey, amount: estimate.amount });
    }
    const expectedByDay = new Map<string, number>();
    for (const candidate of provisionalCandidates) {
      expectedByDay.set(candidate.day, (expectedByDay.get(candidate.day) ?? 0) + candidate.amount);
    }
    for (const candidate of provisionalCandidates) {
      const expected = expectedByDay.get(candidate.day) ?? 0;
      const confirmedWithoutOrder = Math.max(0, unallocatedConfirmedOrderBoostByDay.get(candidate.day) ?? 0);
      const shortfall = Math.max(0, expected - confirmedWithoutOrder);
      const amount = expected > 0 ? candidate.amount * shortfall / expected : 0;
      if (amount > 0) provisionalOrderBoostByOrderId.set(candidate.orderId, amount);
    }
    const linkedOrderBoostExpense = [...linkedOrderBoostByOrderId.values()].reduce((sum, value) => sum + value, 0);
    const provisionalOrderBoostExpense = [...provisionalOrderBoostByOrderId.values()].reduce((sum, value) => sum + value, 0);
    const unallocatedOrderBoostExpense = confirmedOrderBoostExpense - linkedOrderBoostExpense;
    // A completed HTTP pagination is not a business watermark: Uzum can publish
    // today's rows later. Keep the model visible, but never mix it into factual
    // ledger totals or profit.
    const orderBoostExpense = confirmedOrderBoostExpense;
    // TOP has no product/order rate in the API. Do not invent today's amount
    // from yesterday; keep it pending until the factual ledger row arrives.
    const provisionalTopPromotionExpense = 0;
    const topPromotionExpense = confirmedTopPromotionExpense;
    const advertisingExpense = orderBoostExpense + topPromotionExpense;
    const hasAdvertisingEstimate = provisionalOrderBoostExpense > 0;
    const provisionalAdvertisingCoverage = provisionalCandidateRevenue > 0
      ? provisionalCoveredRevenue / provisionalCandidateRevenue * 100
      : 100;
    const hasUnknownPendingAdvertisingRate = provisionalCandidateRevenue > provisionalCoveredRevenue + 0.01;
    const freshAdvertisingMayBeIncomplete = freshPeriodKeys.length > 0;
    const provisionalOrderBoostSourceDate: string | null = null;
    const provisionalTopSourceDate: string | null = null;
    const financialRows = calculatedFinancialRows.map((row) => {
      const revenueShare = financialRevenue > 0 ? row.gross / financialRevenue : 0;
      const linkedOrderBoost = linkedOrderBoostByOrderId.get(row.order.id) ?? 0;
      const provisionalOrderBoost = provisionalOrderBoostByOrderId.get(row.order.id) ?? 0;
      const orderBoost = linkedOrderBoost + unallocatedOrderBoostExpense * revenueShare;
      const topPromotion = topPromotionExpense * revenueShare;
      const advertising = orderBoost + topPromotion;
      const profit = row.payout - row.internalCosts - row.tax - advertising;
      return { ...row, orderBoost, orderBoostEstimate: provisionalOrderBoost, topPromotion, advertising, profit, marginPercent: row.gross > 0 ? profit / row.gross * 100 : 0 };
    });

    // Кошелёк строится не от даты заказа и не от оплаты покупателя, а от даты фактической выдачи Uzum — dateIssued/issuedAt.
    // В корзину вывода сумма попадает после 10 полных календарных дней удержания: на 11-й день после выдачи.
    const forecastNow = new Date();
    const forecastFrom = new Date(forecastNow.getTime() - (payoutDelayDays + 75) * 86_400_000);
    const forecastTo = new Date(forecastNow.getTime() + 86_400_000);
    const forecastOrders = await this.loadWalletOrders(shop.id, forecastFrom, forecastTo);
    // Past and today's wallet inflow is factual TO_WITHDRAW only. For future
    // dates include issued PAID orders so upcoming basket receipts do not
    // disappear; PROCESSING due today remains excluded until Uzum confirms it.
    const forecastTodayKey = tashkentKey(forecastNow);
    const forecastEligible = forecastOrders.filter((order) => {
      const issued = order.dateIssued || order.issuedAt;
      if (!issued || Number(order.payout) <= 0) return false;
      if (order.status === 'TO_WITHDRAW') return true;
      return this.state(order) === 'PAID'
        && basketEligibleDate(issued, payoutDelayDays) > forecastTodayKey;
    });
    const forecastFinancialRows: FinancialRow[] = forecastEligible.map((order) => ({ order, ...this.financials(order, taxPercent, 0, fallbackCommissionPercent) }));
    // The daily calendar is a history/forecast of the full amount entering the
    // withdrawal basket. Do not subtract withdrawals here: that would turn a
    // day's inflow into the current remainder and make past/today rows shrink.
    const withdrawalBasketBase = buildWithdrawalBasket(forecastFinancialRows.map((row) => ({
      id: row.order.id,
      externalId: row.order.externalId,
      marketplaceOrderId: row.order.marketplaceOrderId,
      orderedAt: row.order.orderedAt,
      issuedAt: row.order.dateIssued || (row.order as any).issuedAt || row.order.paidAt,
      dateIssued: row.order.dateIssued,
      gross: row.gross,
      payout: row.payout,
      units: this.units([row.order]),
      returnedUnits: row.order.returnedUnits,
      returnAmount: Number(row.order.returnAmount),
    })), { holdDays: payoutDelayDays, schedule: payoutSchedule, serviceFeePercent: payoutServiceFeePercent, now: forecastNow });

    // Current availability is a balance, so unlike the daily calendar it must
    // account for amounts that have already been withdrawn.
    const remainingWithdrawalBasketBase = buildWithdrawalBasket(forecastFinancialRows.map((row) => ({
      id: row.order.id,
      externalId: row.order.externalId,
      marketplaceOrderId: row.order.marketplaceOrderId,
      orderedAt: row.order.orderedAt,
      issuedAt: row.order.dateIssued || (row.order as any).issuedAt || row.order.paidAt,
      dateIssued: row.order.dateIssued,
      gross: row.gross,
      payout: this.remainingPayout(row.order, row.payout),
      units: this.units([row.order]),
      returnedUnits: row.order.returnedUnits,
      returnAmount: Number(row.order.returnAmount),
    })), { holdDays: payoutDelayDays, schedule: payoutSchedule, serviceFeePercent: payoutServiceFeePercent, now: forecastNow });

    const selectedPeriodBasketBase = buildWithdrawalBasket(financialRows.map((row) => ({
      id: row.order.id,
      externalId: row.order.externalId,
      marketplaceOrderId: row.order.marketplaceOrderId,
      orderedAt: row.order.orderedAt,
      issuedAt: row.order.dateIssued || (row.order as any).issuedAt || row.order.paidAt,
      dateIssued: row.order.dateIssued,
      gross: row.gross,
      payout: row.payout,
      units: this.units([row.order]),
      returnedUnits: row.order.returnedUnits,
      returnAmount: Number(row.order.returnAmount),
    })), { holdDays: payoutDelayDays, schedule: payoutSchedule, serviceFeePercent: payoutServiceFeePercent, now: forecastNow });

    const paidBalanceOrders = balanceOrders.filter((order) => order.status === 'TO_WITHDRAW' && order.issuedAt);
    const sellerProfitTotal = paidBalanceOrders.reduce((sum, order) => sum + Number(order.payout), 0);
    const withdrawnTotal = paidBalanceOrders.reduce((sum, order) => {
      if (order.statementImportedAt) return sum + Number(order.withdrawnAmount || 0);
      const apiValue = Number(order.apiWithdrawnAmount || 0);
      if (Number.isFinite(apiValue) && apiValue > 0) return sum + apiValue;
      const raw = order.raw && typeof order.raw === 'object' && !Array.isArray(order.raw)
        ? order.raw as Record<string, unknown>
        : {};
      const value = Number(raw.withdrawnProfit ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    // OUTCOME is stored as a positive amount, INCOME/refund as a negative amount.
    const marketplaceExpenseLedgerTotal = balanceExpenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
    const balanceAdvertisingExpense = balanceExpenses
      .filter((expense) => {
        const code = baseAdvertisingCode(expense.code);
        return code === ORDER_BOOST_CODE || code === TOP_PROMOTION_CODE;
      })
      .reduce((sum, expense) => sum + Number(expense.amount), 0);
    const balanceLogisticsExpense = balanceExpenses
      .filter((expense) => /logistic/i.test(`${expense.code || ''} ${expense.name || ''}`))
      .reduce((sum, expense) => sum + Number(expense.amount), 0);
    // Order logistics is already included in sellerProfit. Return-logistics refunds belong
    // to the same ledger and are excluded with it, so neither side is counted twice.
    const additionalExpenseTotal = marketplaceExpenseLedgerTotal - balanceLogisticsExpense;
    const balanceOtherExpense = additionalExpenseTotal - balanceAdvertisingExpense;
    // TO_WITHDRAW is the marketplace financial ledger after its order/service postings.
    // Expense rows remain available as a breakdown, but subtracting them here again
    // would double-count postings already reflected by Uzum in this balance state.
    const calculatedOverallBalance = Math.max(0, sellerProfitTotal - withdrawnTotal);
    const statementSummary = latestFinancialStatement?.summary && typeof latestFinancialStatement.summary === 'object' && !Array.isArray(latestFinancialStatement.summary)
      ? latestFinancialStatement.summary as Record<string, unknown>
      : null;
    const importedOverallBalance = Number(statementSummary?.reportedEndingBalance ?? statementSummary?.overallBalance);
    const importedAvailableEarly = Number(statementSummary?.availableEarly);
    const hasStatementBalance = Boolean(latestFinancialStatement && Number.isFinite(importedOverallBalance));
    const hasStatementAvailable = Boolean(latestFinancialStatement && Number.isFinite(importedAvailableEarly));
    const overallBalance = hasStatementBalance ? Math.max(0, importedOverallBalance) : calculatedOverallBalance;

    const visibleBasketDailyRows = withdrawalBasketBase.basketDailyRows.filter((row) => {
      const deltaDays = Math.round((new Date(`${row.date}T12:00:00+05:00`).getTime() - new Date(`${withdrawalBasketBase.today}T12:00:00+05:00`).getTime()) / 86_400_000);
      return deltaDays >= -14 && deltaDays <= 45;
    });
    const visiblePayoutDailyRows = withdrawalBasketBase.payoutDailyRows.filter((row) => {
      const deltaDays = Math.round((new Date(`${row.date}T12:00:00+05:00`).getTime() - new Date(`${withdrawalBasketBase.today}T12:00:00+05:00`).getTime()) / 86_400_000);
      return deltaDays >= -21 && deltaDays <= 60;
    });
    const selectedDates = selectedPeriodBasketBase.basketDailyRows.map((row) => row.date);
    const selectedScheduledDates = selectedPeriodBasketBase.basketDailyRows.map((row) => row.scheduledPayoutDate);
    const payoutForecast = {
      holdDays: payoutDelayDays,
      delayDays: payoutDelayDays,
      schedule: payoutSchedule,
      serviceFeePercent: payoutServiceFeePercent,
      urgentWithdrawalFeePercent,
      generatedAt: withdrawalBasketBase.generatedAt.toISOString(),
      today: withdrawalBasketBase.today,
      tomorrow: withdrawalBasketBase.tomorrow,
      summary: {
        ...withdrawalBasketBase.summary,
        availableToWithdraw: hasStatementAvailable
          ? Math.max(0, importedAvailableEarly)
          : remainingWithdrawalBasketBase.summary.availableToWithdraw,
        overallBalance,
        overallBalanceSource: hasStatementBalance ? 'financial-statement' : 'api-calculation',
        statementAsOf: latestFinancialStatement?.reportAsOf?.toISOString() ?? null,
        calculatedOverallBalance,
        sellerProfitTotal,
        withdrawnTotal,
        additionalExpenseTotal,
        balanceAdvertisingExpense,
        balanceLogisticsExpense,
        balanceOtherExpense,
        marketplaceExpenseLedgerTotal,
      },
      // Главное для управления деньгами: по дням, когда сумма попадает именно в корзину вывода.
      basketDailyRows: visibleBasketDailyRows,
      // Отдельно: сгруппированные даты фактического перечисления по выбранному графику Uzum.
      payoutDailyRows: visiblePayoutDailyRows,
      // rows оставлен для совместимости старых экранов; теперь это тот же календарь корзины по дням.
      rows: visibleBasketDailyRows,
      selectedPeriod: {
        amount: selectedPeriodBasketBase.summary.totalEligibleBasket || selectedPeriodBasketBase.summary.totalTracked,
        orders: selectedPeriodBasketBase.rows.reduce((sum, row) => sum + row.orders, 0),
        units: selectedPeriodBasketBase.rows.reduce((sum, row) => sum + row.units, 0),
        basketFrom: selectedDates[0] || null,
        basketTo: selectedDates[selectedDates.length - 1] || null,
        expectedFrom: selectedScheduledDates[0] || null,
        expectedTo: selectedScheduledDates[selectedScheduledDates.length - 1] || null,
      },
      note: `Корзина вывода считается по dateIssued: сумма появляется через ${payoutDelayDays} календарных дней после выдачи. Отдельно показан график выплаты в банк по расписанию ${payoutSchedule}; праздники и фактическое зачисление нужно сверять с Uzum/банком.`,
    };


    const revenue = this.sum(financialRows, 'gross');
    const payout = this.sum(financialRows, 'payout');
    const commission = this.sum(financialRows, 'commission');
    const marketplaceLogistics = this.sum(financialRows, 'marketplaceLogistics');
    const otherMarketplaceDeductions = this.sum(financialRows, 'otherMarketplaceDeductions');
    const productCost = this.sum(financialRows, 'productCost');
    const packagingCost = this.sum(financialRows, 'packagingCost');
    const warehouseLogisticsCost = this.sum(financialRows, 'warehouseLogisticsCost');
    const additionalCost = this.sum(financialRows, 'additionalCost');
    const cogs = productCost + packagingCost + warehouseLogisticsCost + additionalCost;
    const taxExpense = this.sum(financialRows, 'tax');
    const profit = payout - cogs - taxExpense - advertisingExpense - otherMarketplaceFeesExpense;
    const expenses = commission + marketplaceLogistics + otherMarketplaceDeductions + cogs + taxExpense + advertisingExpense + otherMarketplaceFeesExpense;
    const commissionPercent = revenue > 0 ? commission / revenue * 100 : 0;
    const effectiveAdvertisingPercent = revenue > 0 ? advertisingExpense / revenue * 100 : 0;
    const payoutDifference = this.sum(financialRows, 'payoutDifference');
    const returnReserve = this.sum(financialRows, 'returnReserve' as any);

    const expenseUnits = (expense: typeof fulfillmentExpenses[number]) => Math.max(1, Math.round(Number((expense.raw as any)?.amount ?? 1)));
    const issuedTodayUnits = fulfillmentExpenses.filter((expense) => String(expense.code || '').startsWith('logistics-') && expense.type === 'OUTCOME').reduce((sum, expense) => sum + expenseUnits(expense), 0);
    const returnedTodayRows = fulfillmentExpenses.filter((expense) => String(expense.code || '').startsWith('return-logistics-') && expense.type === 'INCOME');
    const returnedTodayUnits = returnedTodayRows.reduce((sum, expense) => sum + expenseUnits(expense), 0);
    const returnedTodayOrders = returnedTodayRows.length;
    const returnedTodayAmount = returnedTodayRows.reduce((sum, expense) => sum + Math.abs(Number(expense.amount)), 0);
    const paidUnits = paid.reduce((sum, order) => {
      const orderUnits = order.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
      return sum + Math.max(0, orderUnits - Math.max(0, order.returnedUnits || 0));
    }, 0);
    const waitingUnits = this.units(waiting);
    const otherUnits = this.units(otherActive);
    const orderedUnits = this.units(orderedActiveOrders);
    const waitingRevenue = waiting.reduce((total, order) => total + Number(order.grossRevenue), 0);
    const otherRevenue = otherActive.reduce((total, order) => total + Number(order.grossRevenue), 0);
    const orderedRevenue = orderedActiveOrders.reduce((total, order) => total + Number(order.grossRevenue), 0);
    // This is the payout Uzum returned for orders CREATED in the selected period.
    // Do not calculate it from gross or subtract commission/logistics again: the API
    // payout is already net of those marketplace deductions.
    const orderedPayoutOrders = orderedActiveOrders.filter((order) => order.payoutReported);
    const orderedPayout = orderedPayoutOrders.reduce((total, order) => total + Number(order.payout), 0);
    const orderedPayoutReportedOrders = this.uniqueOrderCount(orderedPayoutOrders);
    const orderedPayoutPendingOrders = Math.max(0, this.uniqueOrderCount(orderedActiveOrders) - orderedPayoutReportedOrders);
    // Potential orders are the active order-created cohort. Do not apply returnedUnits
    // here: return adjustments belong to the issued/realized cohort below and were
    // incorrectly removing COGS from today's potential orders.
    const orderedCostParts = orderedActiveOrders.flatMap((order) => order.items.map((item) => this.costPartsAtDate(item, order.orderedAt || order.dateIssued)));
    const orderedItemsNeedingCost = orderedActiveOrders.flatMap((order) => order.items).filter((item) => item.quantity > 0);
    const orderedMissingCostItems = orderedItemsNeedingCost.filter((item) => !item.sku?.costs?.length).length;
    const orderedCostCoverage = orderedItemsNeedingCost.length
      ? (orderedItemsNeedingCost.length - orderedMissingCostItems) / orderedItemsNeedingCost.length * 100
      : 100;
    const orderedProductCost = orderedCostParts.reduce((sum, row) => sum + row.productCost, 0);
    const orderedPackagingCost = orderedCostParts.reduce((sum, row) => sum + row.packagingCost, 0);
    const orderedWarehouseLogisticsCost = orderedCostParts.reduce((sum, row) => sum + row.warehouseLogisticsCost, 0);
    const orderedAdditionalCost = orderedCostParts.reduce((sum, row) => sum + row.additionalCost, 0);
    const orderedCogs = orderedProductCost + orderedPackagingCost + orderedWarehouseLogisticsCost + orderedAdditionalCost;
    const orderedTaxExpense = orderedRevenue * taxPercent / 100;
    const orderedAdvertising = orderedActiveOrders.reduce((total, order) => {
      const estimate = advertisingEstimateAt(order.items.map((item) => ({
        amount: Number(item.amount),
        productExternalId: item.sku?.product.externalId || item.marketplaceProductId || null,
      })), productAdvertisingTimeline, order.orderedAt || order.dateIssued, {
        maxRateAgeDays: ADVERTISING_RATE_MAX_AGE_DAYS,
      });
      total.amount += estimate.amount;
      total.coveredRevenue += estimate.coveredRevenue;
      total.totalRevenue += estimate.totalRevenue;
      return total;
    }, { amount: 0, coveredRevenue: 0, totalRevenue: 0 });
    const orderedAdvertisingEstimate = orderedAdvertising.amount;
    const orderedTopPromotionExpense = confirmedTopPromotionExpense;
    const orderedAdvertisingCoverage = orderedAdvertising.totalRevenue > 0
      ? orderedAdvertising.coveredRevenue / orderedAdvertising.totalRevenue * 100
      : 100;
    const orderedPotentialProfitKnown = orderedPayoutPendingOrders === 0
      && orderedAdvertisingCoverage >= 99.999
      && orderedCostCoverage >= 99.999
      && !freshAdvertisingMayBeIncomplete;
    const orderedPotentialProfitEstimate = orderedPayout - orderedCogs - orderedTaxExpense
      - orderedAdvertisingEstimate - orderedTopPromotionExpense;
    const orderedPotentialProfit = orderedPotentialProfitKnown ? orderedPotentialProfitEstimate : null;
    const orderedCostMap = new Map<string, { sellerSku: string; title: string; units: number; productCost: number; warehouseLogisticsCost: number }>();
    orderedActiveOrders.forEach((order) => order.items.forEach((item) => {
      const parts = this.costPartsAtDate(item, order.orderedAt || order.dateIssued);
      const sellerSku = item.sku?.sellerSku || item.externalId || 'Без SKU';
      const current = orderedCostMap.get(sellerSku) || { sellerSku, title: item.title, units: 0, productCost: 0, warehouseLogisticsCost: 0 };
      current.units += item.quantity;
      current.productCost += parts.productCost;
      current.warehouseLogisticsCost += parts.warehouseLogisticsCost;
      orderedCostMap.set(sellerSku, current);
    }));
    const orderedCostBreakdown = [...orderedCostMap.values()].sort((a, b) => b.productCost - a.productCost);
    const sellerProfitAfterAdsAndProductCost = profit;

    // По каждому заказу, СОЗДАННОМУ в периоде (не по дате выдачи). Буст заказов
    // оценивается по ставке товара на момент заказа — та же логика, что и в
    // агрегате orderedAdvertising: не «вся кампания за день», а ставка именно
    // этого товара, наблюдавшаяся Uzum. Буст в ТОП у Uzum не разбит по товарам,
    // поэтому здесь на заказ не разносится и показан только агрегатом.
    const orderedOrderMap = new Map<string, any>();
    for (const order of orderedActiveOrders) {
      const row = this.financials(order, taxPercent, 0, fallbackCommissionPercent);
      const estimate = advertisingEstimateAt(order.items.map((item) => ({
        amount: Number(item.amount),
        productExternalId: item.sku?.product.externalId || item.marketplaceProductId || null,
      })), productAdvertisingTimeline, order.orderedAt || order.dateIssued, {
        maxRateAgeDays: ADVERTISING_RATE_MAX_AGE_DAYS,
      });
      const key = order.marketplaceOrderId || order.externalId;
      const current = orderedOrderMap.get(key) || {
        id: order.id, externalId: order.externalId, marketplaceOrderId: order.marketplaceOrderId,
        orderedAt: order.orderedAt, state: this.state(order),
        units: 0, gross: 0, commission: 0, marketplaceLogistics: 0, payout: 0,
        productCost: 0, warehouseLogisticsCost: 0, packagingCost: 0, additionalCost: 0, tax: 0,
        orderBoostEstimate: 0, orderBoostRateKnown: true,
        payoutReported: true, costsKnown: true, items: [] as any[],
      };
      if (this.state(order) === 'PAID') current.state = 'PAID';
      current.units += this.units([order]);
      current.gross += row.gross;
      current.commission += row.commission;
      current.marketplaceLogistics += row.marketplaceLogistics;
      current.payout += row.payout;
      current.productCost += row.productCost;
      current.warehouseLogisticsCost += row.warehouseLogisticsCost;
      current.packagingCost += row.packagingCost;
      current.additionalCost += row.additionalCost;
      current.tax += row.tax;
      current.orderBoostEstimate += estimate.amount;
      current.orderBoostRateKnown = current.orderBoostRateKnown && estimate.totalRevenue <= estimate.coveredRevenue + 0.01;
      current.payoutReported = current.payoutReported && order.payoutReported;
      current.costsKnown = current.costsKnown && order.items.every((item) => Boolean(item.sku?.costs?.length));
      current.items.push(...order.items.map((item) => ({
        id: item.id, title: item.title, sellerSku: item.sku?.sellerSku || null, quantity: item.quantity, amount: Number(item.amount),
      })));
      orderedOrderMap.set(key, current);
    }
    const orderedOrderRows = [...orderedOrderMap.values()].map((o) => ({
      ...o,
      profitPotential: o.payout - o.productCost - o.warehouseLogisticsCost - o.packagingCost - o.additionalCost - o.tax - o.orderBoostEstimate,
      profitPotentialKnown: o.payoutReported && o.costsKnown && o.orderBoostRateKnown,
    })).sort((a, b) => new Date(b.orderedAt).getTime() - new Date(a.orderedAt).getTime());

    const previousPaid = previous.filter((order) => this.state(order) === 'PAID');
    const calculatedPreviousRows: FinancialRow[] = previousPaid.map((order) => ({ order, ...this.financials(order, taxPercent, 0, fallbackCommissionPercent) }));
    const previousAdvertisingExpense = previousOrderBoostExpenses.reduce((sum, item) => sum + Number(item.amount), 0)
      + previousTopExpenses.reduce((sum, item) => sum + Number(item.amount), 0);
    const previousRevenue = this.sum(calculatedPreviousRows, 'gross');
    const previousRows: FinancialRow[] = calculatedPreviousRows.map((row) => {
      const advertising = previousRevenue > 0 ? previousAdvertisingExpense * row.gross / previousRevenue : 0;
      const profit = row.payout - row.internalCosts - row.tax - advertising;
      return { ...row, advertising, profit, marginPercent: row.gross > 0 ? profit / row.gross * 100 : 0 };
    });
    const previousPayout = this.sum(previousRows, 'payout');
    const previousProfit = this.sum(previousRows, 'profit');
    const previousUnits = this.units(previousPaid);
    const previousExpenses = previousRows.reduce((total, row) => total + row.marketplaceWithheld + row.internalCosts + row.tax + row.advertising, 0);
    const deltas = period.compare ? {
      revenue: this.delta(revenue, previousRevenue),
      payout: this.delta(payout, previousPayout),
      profit: this.delta(profit, previousProfit),
      orders: this.delta(this.uniqueOrderCount(paid), this.uniqueOrderCount(previousPaid)),
      units: this.delta(paidUnits, previousUnits),
      expenses: this.delta(expenses, previousExpenses),
    } : null;

    const daysMap = new Map<string, { date: string; label: string; revenue: number; orders: number; profit: number }>();
    for (let cursor = new Date(from); cursor <= to; cursor = new Date(cursor.getTime() + 86_400_000)) {
      const key = tashkentKey(cursor);
      daysMap.set(key, { date: key, label: key, revenue: 0, orders: 0, profit: 0 });
    }
    financialRows.forEach((row) => {
      const key = tashkentKey(row.order.dateIssued);
      const day = daysMap.get(key);
      if (day) { day.revenue += row.gross; day.orders += 1; day.profit += row.profit; }
    });

    const profitDaysTo = to;
    const profitDaysFrom = from;
    const profitAdsFrom = profitDaysFrom;
    const profitAdsTo = profitDaysTo;
    const [profitDayIssuedOrders, profitDayAdExpenses] = await Promise.all([
      this.loadOrders(shop.id, profitDaysFrom, profitDaysTo),
      this.prisma.marketplaceExpense.findMany({
        where: { shopId: shop.id, code: { in: [...ADVERTISING_EXPENSE_CODES] }, serviceAt: { gte: profitAdsFrom, lte: profitAdsTo } },
      }),
    ]);
    const profitDayPaidOrders = profitDayIssuedOrders.filter((order) => this.state(order) === 'PAID');
    const dayOrders = profitDayPaidOrders.map((order) => {
      const row = this.financials(order, taxPercent, 0, fallbackCommissionPercent);
      return {
        date: order.issuedAt || order.dateIssued, revenue: row.gross,
        units: Math.max(0, this.units([order]) - Math.max(0, order.returnedUnits || 0)),
        payout: row.payout, productCost: row.productCost,
        packagingAndAdditional: row.packagingCost + row.additionalCost,
        marketplaceLogistics: row.marketplaceLogistics, warehouseLogistics: row.warehouseLogisticsCost, tax: row.tax,
      };
    });
    const dayPurchases = profitDayPaidOrders.map((order) => {
      const row = this.financials(order, taxPercent, 0, fallbackCommissionPercent);
      return {
        date: order.dateIssued, revenue: row.gross,
        units: Math.max(0, this.units([order]) - Math.max(0, order.returnedUnits || 0)),
      };
    });
    const dayAds = profitDayAdExpenses.map((expense) => ({ date: expense.serviceAt, amount: Number(expense.amount) }));
    // Динамическая оценка рекламы по последней наблюдавшейся ставке товара
    // («процент за продажу»). Нужна для вчера/сегодня, когда фактический ledger
    // Uzum ещё не пришёл, чтобы профит за эти дни не прятался за прочерком.
    const dayAdEstimates = profitDayPaidOrders.map((order) => {
      const estimate = advertisingEstimateAt(order.items.map((item) => ({
        amount: Number(item.amount) * (item.quantity > 0
          ? Math.max(0, item.quantity - Math.max(0, item.returns)) / item.quantity
          : 0),
        productExternalId: item.sku?.product.externalId || item.marketplaceProductId || null,
      })), productAdvertisingTimeline, order.orderedAt || order.issuedAt || order.dateIssued, {
        maxRateAgeDays: ADVERTISING_RATE_MAX_AGE_DAYS,
      });
      return { date: order.issuedAt || order.dateIssued, amount: estimate.amount };
    });
    const dayInputKnown = new Map<string, boolean>();
    for (const order of profitDayPaidOrders) {
      const key = tashkentKey(order.issuedAt || order.dateIssued);
      const costsKnown = order.items.every((item) => (
        Math.max(0, item.quantity - Math.max(0, item.returns)) === 0 || Boolean(item.sku?.costs?.length)
      ));
      dayInputKnown.set(key, (dayInputKnown.get(key) ?? true) && order.payoutReported && costsKnown);
    }
    const builtProfitDays = buildProfitDays(profitDaysFrom, profitDaysTo, dayOrders, dayPurchases, dayAds, dayAdEstimates, dayOtherFees);
    const profitDays = builtProfitDays.days.map((day) => ({
      ...day,
      // Полностью фактический профит: выплата и себестоимость известны И день не свежий.
      profitKnown: (dayInputKnown.get(day.date) ?? true) && !freshPeriodKeys.includes(day.date),
      // Профит с оценкой рекламы: показывается за вчера/сегодня, когда выплата и
      // себестоимость известны, а не хватает только финального ledger рекламы.
      profitEstimateKnown: (dayInputKnown.get(day.date) ?? true),
    }));
    const profitDaysSummary = {
      ...builtProfitDays.summary,
      profitKnown: profitDays.every((day) => day.profitKnown),
      profitEstimateKnown: profitDays.every((day) => day.profitEstimateKnown),
    };
    const profitDayByDate = new Map(profitDays.map((day) => [day.date, day]));
    for (const day of daysMap.values()) day.profit = profitDayByDate.get(day.date)?.profit ?? 0;

    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour: `${String(hour).padStart(2, '0')}:00`, label: `${String(hour).padStart(2, '0')}:00`, revenue: 0, orders: 0, units: 0, profit: 0 }));
    financialRows.forEach((row) => {
      const hour = tashkentHour(row.order.dateIssued);
      hourly[hour].revenue += row.gross;
      hourly[hour].orders += 1;
      hourly[hour].units += this.units([row.order]);
      hourly[hour].profit += row.profit;
    });

    const dailyChart = [...daysMap.values()];
    let chart: Array<{ label: string; revenue: number; orders: number; profit: number }> = dailyChart;
    let chartGranularity: 'hour' | 'day' | 'week' | 'month' = 'day';
    if (days === 1) {
      chart = hourly;
      chartGranularity = 'hour';
    } else if (days > 180) {
      const buckets = new Map<string, { label: string; revenue: number; orders: number; profit: number }>();
      dailyChart.forEach((day) => {
        const key = day.date.slice(0, 7);
        const row = buckets.get(key) || { label: key, revenue: 0, orders: 0, profit: 0 };
        row.revenue += day.revenue; row.orders += day.orders; row.profit += day.profit; buckets.set(key, row);
      });
      chart = [...buckets.values()];
      chartGranularity = 'month';
    } else if (days > 45) {
      chart = [];
      dailyChart.forEach((day, index) => {
        const bucketIndex = Math.floor(index / 7);
        if (!chart[bucketIndex]) chart[bucketIndex] = { label: day.date, revenue: 0, orders: 0, profit: 0 };
        chart[bucketIndex].revenue += day.revenue;
        chart[bucketIndex].orders += day.orders;
        chart[bucketIndex].profit += day.profit;
      });
      chartGranularity = 'week';
    }

    const topMap = new Map<string, { title: string; revenue: number; units: number; profit: number; profitKnown: boolean }>();
    financialRows.forEach((row) => {
      const itemRows = row.order.items.map((item) => {
        const netRatio = item.quantity > 0
          ? Math.max(0, item.quantity - Math.max(0, item.returns)) / item.quantity
          : 0;
        return { item, netRatio, revenue: Number(item.amount) * netRatio };
      });
      const itemRevenueTotal = itemRows.reduce((sum, item) => sum + item.revenue, 0);
      for (const { item, netRatio, revenue: itemRevenue } of itemRows) {
        const share = itemRevenueTotal > 0 ? itemRevenue / itemRevenueTotal : 1 / Math.max(1, itemRows.length);
        const itemProfit = row.payout * share - row.internalCosts * share - row.tax * share - row.advertising * share;
        const key = item.skuId || item.title;
        const current = topMap.get(key) || { title: item.title, revenue: 0, units: 0, profit: 0, profitKnown: true };
        current.revenue += itemRevenue;
        current.units += item.quantity * netRatio;
        current.profit += itemProfit;
        current.profitKnown = current.profitKnown
          && row.order.payoutReported
          && (netRatio === 0 || Boolean(item.sku?.costs?.length))
          && !freshPeriodKeys.includes(tashkentKey(row.order.issuedAt || row.order.dateIssued));
        topMap.set(key, current);
      }
    });
    const topProducts = [...topMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const stockValue = skus.reduce((total, sku) => {
      const cost = sku.costs[0];
      const landedCost = cost ? Number(cost.amount) + Number(cost.packagingCost) + Number(cost.warehouseLogisticsCost) + Number(cost.additionalCost) : 0;
      return total + sku.stock * landedCost;
    }, 0);

    let inventorySummary: any = null;
    let risks: any[] = [];
    if (latestInventory) {
      const reportMetrics = latestInventory.metrics;
      const sumMetric = (fn: (metric: typeof reportMetrics[number]) => number) => reportMetrics.reduce((sum, metric) => sum + fn(metric), 0);
      const inventoryAdvertisingRate = (metric: typeof reportMetrics[number]) => productAdvertisingRates.get(String(metric.productExternalId || metric.sku?.product.externalId || ''))?.percent ?? 0;
      const knownProfitRows = reportMetrics.filter((metric) => metric.sku?.costs[0]
        && Number(metric.sku?.price || 0) > 0
        && productAdvertisingRates.has(String(metric.productExternalId || metric.sku?.product.externalId || '')));
      const potentialNetProfit = knownProfitRows.reduce((sum, metric) => {
        const cost = metric.sku!.costs[0];
        const landed = Number(cost.amount) + Number(cost.packagingCost) + Number(cost.warehouseLogisticsCost) + Number(cost.additionalCost);
        const saleValue = Number(metric.sku!.price) * metric.marketplaceTotal;
        return sum + Number(metric.potentialPayoutTotal) - landed * metric.marketplaceTotal - saleValue * (taxPercent + inventoryAdvertisingRate(metric)) / 100;
      }, 0);
      const inventorySaleValue = knownProfitRows.reduce((sum, metric) => sum + Number(metric.sku!.price) * metric.marketplaceTotal, 0);
      const inventoryAdvertisingEstimate = knownProfitRows.reduce((sum, metric) => sum + Number(metric.sku!.price) * metric.marketplaceTotal * inventoryAdvertisingRate(metric) / 100, 0);
      inventorySummary = {
        reportAsOf: latestInventory.reportAsOf,
        importedAt: latestInventory.importedAt,
        skuCount: reportMetrics.length,
        endingSoonSkus: reportMetrics.filter((metric) => metric.endingSoon).length,
        supplySkus: reportMetrics.filter((metric) => metric.recommendedSupply > 0).length,
        overstockSkus: reportMetrics.filter((metric) => String(metric.coverageIndicator || '').toLowerCase().includes('избыток')).length,
        recommendedSupply: sumMetric((metric) => metric.recommendedSupply),
        targetMarketplaceStock: sumMetric((metric) => metric.marketplaceTotal + metric.recommendedSupply),
        marketplaceTotal: sumMetric((metric) => metric.marketplaceTotal),
        availableForSale: sumMetric((metric) => metric.availableForSale),
        toCustomer: sumMetric((metric) => metric.toCustomer),
        fromCustomer: sumMetric((metric) => metric.fromCustomer),
        defective: sumMetric((metric) => metric.defective),
        potentialPayout: sumMetric((metric) => Number(metric.potentialPayoutTotal)),
        potentialNetProfit,
        advertisedSkus: reportMetrics.filter((metric) => inventoryAdvertisingRate(metric) > 0).length,
        effectiveAdvertisingPercent: inventorySaleValue > 0 ? inventoryAdvertisingEstimate / inventorySaleValue * 100 : 0,
        potentialProfitCoverage: reportMetrics.length ? knownProfitRows.length / reportMetrics.length * 100 : 0,
      };
      risks = reportMetrics
        .filter((metric) => metric.endingSoon || metric.recommendedSupply > 0 || metric.coverageDays <= 10)
        .sort((a, b) => a.coverageDays - b.coverageDays || b.recommendedSupply - a.recommendedSupply)
        .slice(0, 8)
        .map((metric) => ({
          id: metric.id,
          title: metric.productTitle,
          sku: metric.sellerSku,
          stock: metric.availableForSale,
          daysLeft: metric.coverageDays,
          recommendedSupply: metric.recommendedSupply,
          status: metric.endingSoon ? 'Заканчивается' : metric.recommendedSupply > 0 ? 'Нужна поставка' : 'Малый запас',
        }));
    } else {
      risks = skus.filter((sku) => sku.stock <= 10).sort((a, b) => a.stock - b.stock).slice(0, 8).map((sku) => ({
        id: sku.id,
        title: sku.product.title,
        sku: sku.sellerSku,
        stock: sku.stock,
        daysLeft: null,
        recommendedSupply: null,
        status: sku.stock === 0 ? 'Нет в наличии' : sku.stock <= 5 ? 'Критично' : 'Заканчивается',
      }));
    }

    const waterfall = [
      { key: 'gross', label: '1. Сумма оплаченных заказов', value: revenue, type: 'income', percent: 100 },
      { key: 'commission', label: '2. Комиссия маркетплейса', value: -commission, type: 'expense', percent: commissionPercent },
      { key: 'marketplaceLogistics', label: '3. Логистика Uzum', value: -marketplaceLogistics, type: 'expense', percent: revenue ? marketplaceLogistics / revenue * 100 : 0 },
      { key: 'otherMarketplace', label: '4. Прочие удержания Uzum', value: -otherMarketplaceDeductions, type: 'expense', percent: revenue ? otherMarketplaceDeductions / revenue * 100 : 0 },
      { key: 'payout', label: '5. Выдаётся продавцу / в корзину после удержания', value: payout, type: 'subtotal', percent: revenue ? payout / revenue * 100 : 0 },
      { key: 'productCost', label: '6. Себестоимость товара', value: -productCost, type: 'expense', percent: revenue ? productCost / revenue * 100 : 0 },
      { key: 'warehouseLogistics', label: '7. Логистика до склада', value: -warehouseLogisticsCost, type: 'expense', percent: revenue ? warehouseLogisticsCost / revenue * 100 : 0 },
      { key: 'packagingAdditional', label: '8. Упаковка и прочие расходы', value: -(packagingCost + additionalCost), type: 'expense', percent: revenue ? (packagingCost + additionalCost) / revenue * 100 : 0 },
      { key: 'orderBoost', label: '9. Буст заказов (подтверждённый факт API)', value: -orderBoostExpense, type: 'expense', percent: revenue ? orderBoostExpense / revenue * 100 : 0 },
      { key: 'topPromotion', label: '10. Буст в ТОП (подтверждённый факт API)', value: -topPromotionExpense, type: 'expense', percent: revenue ? topPromotionExpense / revenue * 100 : 0 },
      { key: 'tax', label: `11. Налог ${taxPercent}%`, value: -taxExpense, type: 'expense', percent: taxPercent },
      { key: 'otherFees', label: '12. Хранение, штрафы и доп. услуги Uzum (finance/expenses)', value: -otherMarketplaceFeesExpense, type: 'expense', percent: revenue ? otherMarketplaceFeesExpense / revenue * 100 : 0 },
      { key: 'profit', label: '13. Чистая прибыль', value: profit, type: profit >= 0 ? 'profit' : 'loss', percent: revenue ? profit / revenue * 100 : 0 },
    ];

    const paidOrderCount = this.uniqueOrderCount(paid);
    const waitingOrderCount = this.uniqueOrderCount(waiting);
    const otherOrderCount = this.uniqueOrderCount(otherActive);
    const activeOrderCount = this.uniqueOrderCount(orderedActiveOrders);

    const profitOrderMap = new Map<string, any>();
    for (const row of financialRows) {
      const orderBoost = row.orderBoost;
      const topPromotion = row.topPromotion;
      const units = Math.max(0, this.units([row.order]) - Math.max(0, row.order.returnedUnits || 0));
      const key = row.order.marketplaceOrderId || row.order.externalId;
      const current = profitOrderMap.get(key) || {
        id: row.order.id,
        externalId: row.order.externalId,
        marketplaceOrderId: row.order.marketplaceOrderId,
        issuedAt: row.order.issuedAt || row.order.dateIssued,
        units: 0, gross: 0, commission: 0, marketplaceLogistics: 0, otherMarketplaceDeductions: 0,
        payout: 0, productCost: 0, warehouseLogisticsCost: 0, packagingCost: 0, additionalCost: 0,
        tax: 0, orderBoost: 0, topPromotion: 0, advertising: 0, profit: 0,
        marginPercent: 0, payoutReported: true, costsKnown: true, profitKnown: true, items: [],
      };
      current.units += units;
      current.gross += row.gross;
      current.commission += row.commission;
      current.marketplaceLogistics += row.marketplaceLogistics;
      current.otherMarketplaceDeductions += row.otherMarketplaceDeductions;
      current.payout += row.payout;
      current.productCost += row.productCost;
      current.warehouseLogisticsCost += row.warehouseLogisticsCost;
      current.packagingCost += row.packagingCost;
      current.additionalCost += row.additionalCost;
      current.tax += row.tax;
      current.orderBoost += orderBoost;
      current.topPromotion += topPromotion;
      current.advertising += row.advertising;
      current.profit += row.profit;
      current.payoutReported = current.payoutReported && row.order.payoutReported;
      current.costsKnown = current.costsKnown && row.order.items.every((item) => (
        Math.max(0, item.quantity - Math.max(0, item.returns)) === 0 || Boolean(item.sku?.costs?.length)
      ));
      current.items.push(...row.order.items.map((item) => ({
          id: item.id,
          title: item.title,
          sellerSku: item.sku?.sellerSku || null,
          quantity: item.quantity,
          amount: Number(item.amount),
      })));
      current.marginPercent = current.gross > 0 ? current.profit / current.gross * 100 : 0;
      current.profitKnown = current.profitKnown
        && current.payoutReported
        && current.costsKnown
        && !freshPeriodKeys.includes(tashkentKey(row.order.issuedAt || row.order.dateIssued));
      profitOrderMap.set(key, current);
    }
    const profitOrders = [...profitOrderMap.values()].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());

    const insights = [
      { tone: hasAdvertisingEstimate || hasUnknownPendingAdvertisingRate || freshAdvertisingMayBeIncomplete ? 'warning' : 'positive', title: 'Источник рекламных расходов', text: hasAdvertisingEstimate
        ? `Итог и прибыль содержат только подтверждённый факт Uzum. Отдельно доступна не включённая в итог модельная оценка свежих выкупов по ставке товара. Фактический ДРР ${effectiveAdvertisingPercent.toFixed(1)}%.`
        : hasUnknownPendingAdvertisingRate
          ? `Для части свежих выкупов ставка товара не наблюдалась; рекламный расход и прибыль могут быть неполными. Подтверждённый ДРР сейчас ${effectiveAdvertisingPercent.toFixed(1)}%.`
          : freshAdvertisingMayBeIncomplete
            ? `В итог включён только поступивший факт Uzum (ДРР ${effectiveAdvertisingPercent.toFixed(1)}%). Свежие строки finance/expenses могут появиться позже, поэтому период ещё не финальный.`
            : `Реклама взята из фактических списаний Uzum (ДРР ${effectiveAdvertisingPercent.toFixed(1)}%), налог рассчитан по ставке ${taxPercent}%.` },
      { tone: payoutForecast.summary.dueToday > 0 ? 'positive' : payoutForecast.summary.needsReconcile > 0 ? 'warning' : 'info', title: 'Кошелёк и корзина вывода', text: payoutForecast.summary.dueToday > 0 ? `Сегодня по графику расчётно к перечислению ${Math.round(payoutForecast.summary.dueToday).toLocaleString('ru-RU')} сум.` : payoutForecast.summary.needsReconcile > 0 ? `Прошлые даты выплат нужно сверить: ${Math.round(payoutForecast.summary.needsReconcile).toLocaleString('ru-RU')} сум.` : `Уже в корзине вывода: ${Math.round(payoutForecast.summary.availableToWithdraw).toLocaleString('ru-RU')} сум, в удержании: ${Math.round(payoutForecast.summary.inReturnHold).toLocaleString('ru-RU')} сум.` },
      { tone: waitingUnits ? 'warning' : 'positive', title: `${waitingUnits} шт. ждут оплаты`, text: waitingUnits ? `Потенциальная выручка ${Math.round(waitingRevenue).toLocaleString('ru-RU')} сум ещё не включена в фактические продажи.` : 'Все активные заказы оплачены.' },
      { tone: returnReserve > 0 ? 'warning' : Math.abs(payoutDifference) < 1 ? 'info' : 'warning', title: returnReserve > 0 ? 'Возвраты обнаружены' : 'Контроль выплаты Uzum', text: returnReserve > 0 ? `API передал сумму возвратов ${Math.round(returnReserve).toLocaleString('ru-RU')} сум. Она показана справочно и повторно из уже скорректированной выплаты не вычитается.` : Math.abs(payoutDifference) < 1 ? 'Выплата совпадает с видимыми удержаниями.' : `Разница между выплатой API и формулой: ${Math.round(payoutDifference).toLocaleString('ru-RU')} сум. Она выделена как прочие удержания/корректировки.` },
    ];
    if (realizedPayoutPendingOrders > 0 || realizedMissingCostItems > 0) {
      insights.unshift({
        tone: 'warning',
        title: 'Прибыль не рассчитана полностью',
        text: `Нет фактической выплаты у ${realizedPayoutPendingOrders} строк и себестоимости у ${realizedMissingCostItems} позиций. Эти пропуски не заменяются нулём.`,
      });
    }
    if (inventorySummary) {
      insights.push({
        tone: inventorySummary.endingSoonSkus ? 'warning' : 'positive',
        title: `${inventorySummary.endingSoonSkus} SKU заканчиваются`,
        text: `Uzum рекомендует довезти ${inventorySummary.recommendedSupply} шт. по ${inventorySummary.supplySkus} SKU. Целевой запас после пополнения — ${inventorySummary.targetMarketplaceStock} шт.`,
      });
    }

    let campaignExpenses = periodTopExpenses;
    let campaignsFallback = false;
    if (!campaignExpenses.length) {
      const latestCampaignExpense = await this.prisma.marketplaceExpense.findFirst({
        where: { shopId: shop.id, code: 'У000119', serviceAt: { lte: to } },
        orderBy: { serviceAt: 'desc' },
      });
      if (latestCampaignExpense) {
        campaignExpenses = await this.prisma.marketplaceExpense.findMany({
          where: { shopId: shop.id, code: 'У000119', serviceAt: latestCampaignExpense.serviceAt },
        });
        campaignsFallback = true;
      }
    }
    const campaignDataDate = campaignExpenses.length
      ? tashkentKey(campaignExpenses.reduce((latest, expense) => expense.serviceAt > latest ? expense.serviceAt : latest, campaignExpenses[0].serviceAt))
      : null;
    const campaignMap = new Map<string, { id: string; spend: number; entries: number }>();
    for (const expense of campaignExpenses) {
      const id = expense.campaignExternalId || 'Без ID';
      const row = campaignMap.get(id) || { id, spend: 0, entries: 0 };
      row.spend += Number(expense.amount);
      row.entries += 1;
      campaignMap.set(id, row);
    }

    return {
      shop: { id: shop.id, externalId: shop.externalId, name: shop.name },
      period: { from: period.fromDate, to: period.toDate, days: period.days, compare: period.compare, previousFrom: period.prevFromDate, previousTo: period.prevToDate },
      financialSettings: { taxPercent, advertisingPercent: null, advertisingMode: 'UZUM_FACT', fallbackCommissionPercent, payoutDelayDays, payoutSchedule, payoutServiceFeePercent, urgentWithdrawalFeePercent },
      payoutForecast,
      advertising: {
        orderBoostExpense,
        confirmedOrderBoostExpense,
        provisionalOrderBoostExpense,
        provisionalOrderBoostSourceDate,
        topPromotionExpense,
        confirmedTopPromotionExpense,
        provisionalTopPromotionExpense,
        provisionalTopSourceDate,
        totalExpense: advertisingExpense,
        estimatedAdditionalExpense: provisionalOrderBoostExpense,
        effectivePercent: effectiveAdvertisingPercent,
        linkedOrderBoostExpense,
        unallocatedOrderBoostExpense,
        hasEstimate: hasAdvertisingEstimate,
        provisionalAdvertisingCoverage,
        hasUnknownPendingAdvertisingRate,
        allocationNote: hasAdvertisingEstimate
          ? 'Подтверждённый Буст заказов привязан по ID. Модельная оценка рассчитана по ставке товара, показана отдельно и не включена в факт или прибыль; Буст в ТОП и подтверждённые строки без ID распределены по выручке только для детализации.'
          : 'Буст заказов привязан к заказу по ID; Буст в ТОП и подтверждённые строки без ID распределены пропорционально выручке только для детализации. Подтверждённая сумма равна ledger finance/expenses.',
        campaigns: [...campaignMap.values()].sort((a, b) => b.spend - a.spend),
        campaignDataDate,
        campaignsFallback,
        topExpensePending: freshAdvertisingMayBeIncomplete,
        orderBoostExpensePending: freshAdvertisingMayBeIncomplete || hasUnknownPendingAdvertisingRate,
        freshExpenseMayBeIncomplete: freshAdvertisingMayBeIncomplete,
        expensePeriod: { from: tashkentKey(advertisingFrom), to: tashkentKey(advertisingTo) },
        topExpensePeriod: { from: tashkentKey(topAdvertisingFrom), to: tashkentKey(topAdvertisingTo) },
        note: 'Финансовый API отдаёт фактические суммы и ID кампаний. Ключевые слова, показы и клики в этом endpoint отсутствуют.',
      },
      profitOrders,
      profitDays,
      profitDaysSummary,
      staleWaitingOrders,
      otherFees: {
        amount: otherMarketplaceFeesExpense,
        breakdown: otherFeeBreakdown,
        balanceCorrectionAnomaly,
        note: 'Сборы Uzum из finance/expenses, не входящие ни в рекламу, ни в логистику заказа/поставки: хранение на складе, штрафы приёмки, доп. услуги. Вычтены из чистой прибыли.'
          + (balanceCorrectionAnomaly ? ` Отдельно: перераспределение баланса между магазинами ${Math.round(balanceCorrectionAnomaly).toLocaleString('ru-RU')} сум — это не расход, в прибыль не включено, сверьте вручную.` : ''),
      },
      orderedCostBreakdown,
      orderedOrders: orderedOrderRows,
      metrics: {
        revenue, payout, profit,
        profitKnown: !freshAdvertisingMayBeIncomplete
          && realizedPayoutPendingOrders === 0
          && realizedMissingCostItems === 0,
        realizedPayoutCoverage, realizedPayoutPendingOrders, realizedPayoutPendingOrderRefs,
        realizedCostCoverage, realizedMissingCostItems, realizedMissingCostSkus,
        orderedRevenue, orderedPayout, orderedPayoutReportedOrders, orderedPayoutPendingOrders,
        orderedPotentialProfit, orderedPotentialProfitEstimate, orderedPotentialProfitKnown,
        orderedCogs, orderedProductCost, orderedPackagingCost, orderedCostCoverage, orderedMissingCostItems,
        orderedWarehouseLogisticsCost, orderedAdditionalCost, orderedTaxExpense,
        orderedAdvertisingEstimate, orderedTopPromotionExpense, orderedAdvertisingCoverage,
        sellerProfitAfterAdsAndProductCost,
        orders: activeOrderCount,
        paidOrders: paidOrderCount,
        waitingOrders: waitingOrderCount,
        otherOrders: otherOrderCount,
        paidUnits, waitingUnits, otherUnits, orderedUnits,
        returnedTodayUnits, returnedTodayAmount, returnedTodayOrders,
        paidRevenue: revenue, waitingRevenue, otherRevenue,
        units: paidUnits,
        expenses: -expenses,
        cogs, productCost, packagingCost, warehouseLogisticsCost, additionalCost,
        taxExpense, advertisingExpense, orderBoostExpense, topPromotionExpense, marketplaceLogistics, otherMarketplaceDeductions, otherMarketplaceFeesExpense, returnReserve,
        commission, commissionPercent, payoutDifference,
        returns: this.uniqueOrderCount(groups.RETURNED),
        cancelled: this.uniqueOrderCount(groups.CANCELED),
        products, skus: skus.length, supplies: supplyCount, stockValue,
        delta: deltas?.revenue,
      },
      inventorySummary,
      waterfall,
      chart,
      chartGranularity,
      comparison: period.compare ? {
        period: { from: period.prevFromDate, to: period.prevToDate },
        metrics: { revenue: previousRevenue, payout: previousPayout, profit: previousProfit, orders: this.uniqueOrderCount(previousPaid), units: previousUnits, expenses: previousExpenses },
        deltas,
      } : null,
      hourly,
      topProducts,
      risks,
      goals: goals.map((goal: any) => ({
        id: goal.id,
        metric: goal.metric,
        target: Number(goal.targetValue),
        targetValue: Number(goal.targetValue),
        current: goal.current ?? null,
        progress: goal.progress ?? null,
        startAt: goal.startAt,
        endAt: goal.endAt,
      })),
      insights,
    };
  }
}
