import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { ADVERTISING_EXPENSE_CODES } from '../../common/advertising';
import { calculateOrderFinancials } from '../../common/finance';
import { classifyStoredOrder } from '../../common/order-state';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

type GoalOrder = Prisma.OrderGetPayload<{
  include: { items: { include: { sku: { include: { costs: true } } } } };
}>;

const EXPENSE_PUBLICATION_LAG_MS = 86_400_000;

@Injectable()
export class GoalsService {
  private readonly logger = new Logger(GoalsService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => IntegrationsService)) private readonly integrations: IntegrationsService,
  ) {}

  private currentItemCost(item: GoalOrder['items'][number]) {
    const costs = item.sku?.costs || [];
    return costs.find((cost) => !cost.validTo) ?? null;
  }

  private itemCost(item: GoalOrder['items'][number]) {
    const costs = item.sku?.costs || [];
    // Cost corrections are backfilled in Dashboard and Products. Goals must use
    // the same current active row instead of an expired placeholder that happened
    // to be valid on the sale date. Keep the fallback only for displaying an
    // estimate; an item without an active row is not considered known below.
    const row = this.currentItemCost(item) || costs[0];
    if (!row) return { productCost: 0, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0 };
    return {
      productCost: Number(row.amount) * item.quantity,
      packagingCost: Number(row.packagingCost) * item.quantity,
      warehouseLogisticsCost: Number(row.warehouseLogisticsCost) * item.quantity,
      additionalCost: Number(row.additionalCost) * item.quantity,
    };
  }

  async list() {
    const goals = await this.prisma.goal.findMany({ include: { shop: true }, orderBy: { startAt: 'desc' } });
    const now = new Date();
    return Promise.all(goals.map(async (goal) => {
      // A FULL SUCCESS is written only after syncExpenses has completed and
      // validated every page. Requiring the whole run to start after Uzum's
      // publication window gives us a conservative, schema-free watermark.
      const expenseSyncRequiredAfter = new Date(goal.endAt.getTime() + EXPENSE_PUBLICATION_LAG_MS);
      const [orders, orderedOrders, settings, advertisingExpenses, completedExpenseSync] = await Promise.all([
        this.prisma.order.findMany({
          where: { shopId: goal.shopId, dateIssued: { gte: goal.startAt, lte: goal.endAt } },
          include: { items: { include: { sku: { include: { costs: { orderBy: { validFrom: 'desc' } } } } } } },
        }),
        this.prisma.order.findMany({
          where: { shopId: goal.shopId, orderedAt: { gte: goal.startAt, lte: goal.endAt } },
        }),
        this.prisma.financialSettings.upsert({
          where: { shopId: goal.shopId },
          update: {},
          create: { shopId: goal.shopId, taxPercent: 1, advertisingPercent: 0, marketplaceCommissionFallbackPercent: 0 },
        }),
        this.prisma.marketplaceExpense.findMany({
          where: {
            shopId: goal.shopId,
            code: { in: [...ADVERTISING_EXPENSE_CODES] },
            serviceAt: { gte: goal.startAt, lte: goal.endAt },
          },
        }),
        this.prisma.syncRun.findFirst({
          where: {
            shopId: goal.shopId,
            type: 'FULL',
            status: 'SUCCESS',
            startedAt: { gte: expenseSyncRequiredAfter },
            finishedAt: { not: null, lte: now },
          },
          orderBy: { finishedAt: 'desc' },
          select: { startedAt: true, finishedAt: true },
        }),
      ]);

      const paid = orders.filter((order) => classifyStoredOrder({ status: order.status, state: order.state, paidAt: order.paidAt, amountReturns: order.returnedUnits }) === 'PAID');
      const orderedActive = orderedOrders.filter((order) => !['CANCELED', 'RETURNED'].includes(classifyStoredOrder({ status: order.status, state: order.state, paidAt: order.paidAt, amountReturns: order.returnedUnits })));
      const orderedRevenue = orderedActive.reduce((sum, order) => sum + Number(order.grossRevenue), 0);
      const paidFinancials = paid.map((order) => {
        const costs = order.items.reduce((total, item) => {
          const part = this.itemCost(item);
          const netRatio = item.quantity > 0
            ? Math.max(0, item.quantity - Math.max(0, item.returns)) / item.quantity
            : 0;
          total.productCost += part.productCost * netRatio;
          total.packagingCost += part.packagingCost * netRatio;
          total.warehouseLogisticsCost += part.warehouseLogisticsCost * netRatio;
          total.additionalCost += part.additionalCost * netRatio;
          total.revenue += Number(item.amount) * netRatio;
          total.units += Math.max(0, item.quantity - Math.max(0, item.returns));
          return total;
        }, { productCost: 0, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0, revenue: 0, units: 0 });
        const finance = calculateOrderFinancials({
          gross: costs.revenue,
          payout: Number(order.payout),
          commission: Number(order.commission),
          marketplaceLogistics: Number(order.logistics),
          payoutReported: order.payoutReported,
          commissionReported: order.commissionReported,
          logisticsReported: order.logisticsReported,
          taxPercent: Number(settings.taxPercent),
          advertisingPercent: 0,
          fallbackCommissionPercent: Number(settings.marketplaceCommissionFallbackPercent),
          productCost: costs.productCost,
          packagingCost: costs.packagingCost,
          warehouseLogisticsCost: costs.warehouseLogisticsCost,
          additionalCost: costs.additionalCost,
        });
        return { ...finance, units: costs.units };
      });
      const revenue = paidFinancials.reduce((sum, row) => sum + row.gross, 0);
      const units = paidFinancials.reduce((sum, row) => sum + row.units, 0);
      const uniqueOrders = new Set(paid.map((order) => order.marketplaceOrderId || order.externalId)).size;
      const advertising = advertisingExpenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
      // This is a blended store-level ratio, not sales attributed to campaigns.
      const roas = advertising > 0 ? revenue / advertising : null;
      const profitBeforeAdvertising = paidFinancials.reduce((sum, row) => sum + row.profit, 0);
      const profit = profitBeforeAdvertising - advertising;
      const payoutInputsKnown = paid.every((order) => order.payoutReported);
      const costInputsKnown = paid.every((order) => order.items.every((item) => (
        Math.max(0, item.quantity - Math.max(0, item.returns)) === 0 || Boolean(this.currentItemCost(item))
      )));
      const advertisingFinal = Boolean(
        completedExpenseSync?.finishedAt
        && completedExpenseSync.startedAt >= expenseSyncRequiredAfter
        && completedExpenseSync.finishedAt <= now,
      );
      const financialMetricKnown = payoutInputsKnown && costInputsKnown && advertisingFinal;

      let current: number | null = 0;
      if (goal.metric === 'ORDERED_REVENUE') current = orderedRevenue;
      if (goal.metric === 'REVENUE') current = revenue;
      if (goal.metric === 'PROFIT') current = profit;
      if (goal.metric === 'ORDERS') current = uniqueOrders;
      if (goal.metric === 'UNITS') current = units;
      if (goal.metric === 'ROAS') current = roas;
      const metricKnown = goal.metric === 'PROFIT'
        ? financialMetricKnown
        : goal.metric === 'ROAS'
          ? financialMetricKnown && roas !== null
          : true;
      const progress = metricKnown && current !== null
        ? Math.max(0, Math.min(100, Math.round(current / Math.max(1, Number(goal.targetValue)) * 100)))
        : null;
      return {
        ...goal,
        targetValue: Number(goal.targetValue),
        current,
        progress,
        metricKnown,
        inputCoverage: {
          payoutKnown: payoutInputsKnown,
          costsKnown: costInputsKnown,
          advertisingFinal,
          expenseSyncRequiredAfter,
          expenseSyncWatermark: completedExpenseSync?.finishedAt ?? null,
        },
        ...(goal.metric === 'ROAS' ? { metricLabel: 'Выручка магазина / рекламные расходы', attribution: 'STORE_LEVEL_NONE' } : {}),
      };
    }));
  }

  @Cron('*/15 * * * *')
  async notifyCompletedGoals() {
    try {
      const now = new Date();
      const goals: any[] = await this.list();
      for (const goal of goals) {
        if (!goal.metricKnown || goal.progress === null || goal.progress < 100 || goal.startAt > now) continue;
        const dedupeKey = `goal-achieved:${goal.id}`;
        if (await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) continue;
        const labels: Record<string, string> = { ORDERED_REVENUE: 'сумме заказов', REVENUE: 'выручке', PROFIT: 'чистой прибыли', ORDERS: 'оплаченным заказам', UNITS: 'проданным единицам', ROAS: 'отношению выручки магазина к рекламе' };
        const sent = await this.integrations.notifyTelegram(
          `🎯 Цель выполнена
Показатель: ${labels[goal.metric] || goal.metric}
Результат: ${Math.round(goal.current).toLocaleString('ru-RU')} / ${Math.round(goal.targetValue).toLocaleString('ru-RU')}
Период: ${new Date(goal.startAt).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' })} — ${new Date(goal.endAt).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' })}`,
          'notifyGoals',
        ).catch(() => false);
        if (sent) await this.prisma.notificationLog.create({ data: { type: 'GOAL_ACHIEVED', dedupeKey, payload: { goalId: goal.id } } });
      }
    } catch (error: any) {
      this.logger.error(`Goal notification failed: ${error?.message || error}`);
    }
  }

  create(dto: any) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const startAt = dateOnly.test(dto.startAt) ? new Date(`${dto.startAt}T00:00:00+05:00`) : new Date(dto.startAt);
    const endAt = dateOnly.test(dto.endAt) ? new Date(`${dto.endAt}T23:59:59.999+05:00`) : new Date(dto.endAt);
    return this.prisma.goal.create({ data: { ...dto, startAt, endAt } });
  }

  remove(id: string) { return this.prisma.goal.delete({ where: { id } }); }
}
