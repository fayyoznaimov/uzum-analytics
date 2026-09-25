import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ADVERTISING_EXPENSE_CODES, baseAdvertisingCode, ORDER_BOOST_CODE, TOP_PROMOTION_CODE } from '../../common/advertising';
import { CostBreakdown, calculateOrderFinancials } from '../../common/finance';
import { classifyStoredOrder } from '../../common/order-state';
import { PeriodQuery, resolvePeriod } from '../../common/period';
import { PrismaService } from '../../common/prisma.service';

type ItemWithOrderAndCosts = Prisma.OrderItemGetPayload<{
  include: { order: true; sku: { include: { costs: true } } };
}>;

const ADVERTISING_EXPENSE_PUBLICATION_LAG_MS = 86_400_000;

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  private state(item: ItemWithOrderAndCosts) {
    return classifyStoredOrder({
      status: item.order.status,
      state: item.order.state,
      paidAt: item.order.paidAt,
      amount: item.quantity,
      amountReturns: item.returns,
    });
  }

  private costParts(item: ItemWithOrderAndCosts): CostBreakdown {
    const rows = item.sku?.costs || [];
    const row = rows.find((cost) => !cost.validTo) || rows[0];
    return {
      productCost: row ? Number(row.amount) * item.quantity : 0,
      packagingCost: row ? Number(row.packagingCost) * item.quantity : 0,
      warehouseLogisticsCost: row ? Number(row.warehouseLogisticsCost) * item.quantity : 0,
      additionalCost: row ? Number(row.additionalCost) * item.quantity : 0,
    };
  }

  async list(search?: string, query: PeriodQuery = {}) {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return [];
    const period = resolvePeriod(query);
    const settings = await this.prisma.financialSettings.upsert({
      where: { shopId: shop.id },
      update: {},
      create: { shopId: shop.id, taxPercent: 1, advertisingPercent: 0, marketplaceCommissionFallbackPercent: 0 },
    });
    const taxPercent = Number(settings.taxPercent);
    const fallbackCommissionPercent = Number(settings.marketplaceCommissionFallbackPercent);
    const advertisingExpensePublicationCutoff = new Date(
      period.to.getTime() + ADVERTISING_EXPENSE_PUBLICATION_LAG_MS,
    );

    const [products, advertisingExpenses, periodItems, expenseSyncWatermark] = await Promise.all([this.prisma.product.findMany({
      where: {
        shopId: shop.id,
      },
      include: {
        skus: {
          include: {
            costs: { orderBy: { validFrom: 'desc' } },
          },
        },
      },
      orderBy: { title: 'asc' },
    }), this.prisma.marketplaceExpense.findMany({
      where: {
        shopId: shop.id,
        code: { in: [...ADVERTISING_EXPENSE_CODES] },
        // serviceAt is the actual service/campaign date. createdAt can lag,
        // but must not shift the expense into another sales day.
        serviceAt: {
          gte: period.from,
          lte: period.to,
        },
      },
      select: { code: true, productExternalId: true, amount: true },
    }), this.prisma.orderItem.findMany({
      where: { order: { shopId: shop.id, dateIssued: { gte: period.from, lte: period.to } } },
      include: { order: true, sku: { include: { costs: { orderBy: { validFrom: 'desc' } } } } },
    }), this.prisma.syncRun.findFirst({
      where: {
        shopId: shop.id,
        type: 'FULL',
        status: 'SUCCESS',
        // FULL is marked SUCCESS only after the entire expenses pagination and
        // advertising rebuild finish. Requiring the run itself to start after
        // the publication window is safer than finishedAt alone: a long run can
        // finish after the cutoff even though its expense fetch began before it.
        startedAt: { gte: advertisingExpensePublicationCutoff },
        finishedAt: { not: null },
      },
      orderBy: { finishedAt: 'desc' },
      select: { id: true, finishedAt: true },
    })]);

    const productIdByExternalId = new Map(products.map((product) => [product.externalId, product.id]));
    const itemsByProductId = new Map<string, ItemWithOrderAndCosts[]>();
    const unmatchedItems: ItemWithOrderAndCosts[] = [];
    const productIdFromRaw = (raw: unknown): string | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const source = raw as Record<string, any>;
      const value = source.productId
        ?? source.productExternalId
        ?? source.product?.id
        ?? source.product?.externalId;
      return value === null || value === undefined ? null : String(value).trim() || null;
    };
    for (const item of periodItems as ItemWithOrderAndCosts[]) {
      const productId = item.sku?.productId
        || productIdByExternalId.get(String(item.marketplaceProductId || '').trim())
        || productIdByExternalId.get(productIdFromRaw(item.raw) || '');
      if (!productId) { unmatchedItems.push(item); continue; }
      const rows = itemsByProductId.get(productId) ?? [];
      rows.push(item);
      itemsByProductId.set(productId, rows);
    }

    const catalogProductIds = new Set(products.map((product) => product.externalId));
    const orderBoostByProduct = new Map<string, number>();
    const productsWithDirectOrderBoost = new Set<string>();
    let totalOrderBoostExpense = 0;
    let topPromotionExpense = 0;
    let hasTopPromotionRows = false;
    let hasUnallocatedOrderBoostRows = false;
    for (const expense of advertisingExpenses) {
      const amount = Number(expense.amount);
      if (baseAdvertisingCode(expense.code) === TOP_PROMOTION_CODE) {
        hasTopPromotionRows = true;
        topPromotionExpense += amount;
      } else if (baseAdvertisingCode(expense.code) === ORDER_BOOST_CODE) {
        totalOrderBoostExpense += amount;
        if (expense.productExternalId && catalogProductIds.has(expense.productExternalId)) {
          productsWithDirectOrderBoost.add(expense.productExternalId);
          orderBoostByProduct.set(
            expense.productExternalId,
            (orderBoostByProduct.get(expense.productExternalId) ?? 0) + amount,
          );
        } else hasUnallocatedOrderBoostRows = true;
      }
    }
    const linkedOrderBoostExpense = [...orderBoostByProduct.values()].reduce((sum, amount) => sum + amount, 0);
    const unallocatedOrderBoostExpense = totalOrderBoostExpense - linkedOrderBoostExpense;
    const netItemRevenue = (item: ItemWithOrderAndCosts) => {
      const netRatio = item.quantity > 0
        ? Math.max(0, item.quantity - Math.max(0, item.returns)) / item.quantity
        : 0;
      return Number(item.amount) * netRatio;
    };
    const itemFinancialAllocation = new Map<string, {
      payout: number;
      commission: number;
      marketplaceLogistics: number;
      otherMarketplaceDeductions: number;
    }>();
    const paidItemsByOrder = new Map<string, ItemWithOrderAndCosts[]>();
    for (const item of periodItems as ItemWithOrderAndCosts[]) {
      if (this.state(item) !== 'PAID') continue;
      const rows = paidItemsByOrder.get(item.order.id) ?? [];
      rows.push(item);
      paidItemsByOrder.set(item.order.id, rows);
    }
    for (const rows of paidItemsByOrder.values()) {
      const order = rows[0].order;
      const netRevenue = rows.reduce((sum, item) => sum + netItemRevenue(item), 0);
      const finance = calculateOrderFinancials({
        gross: netRevenue,
        payout: Number(order.payout),
        commission: Number(order.commission),
        marketplaceLogistics: Number(order.logistics),
        payoutReported: order.payoutReported,
        commissionReported: order.commissionReported,
        logisticsReported: order.logisticsReported,
        taxPercent: 0,
        advertisingPercent: 0,
        fallbackCommissionPercent,
        productCost: 0,
        packagingCost: 0,
        warehouseLogisticsCost: 0,
        additionalCost: 0,
      });
      for (const item of rows) {
        const share = netRevenue > 0 ? netItemRevenue(item) / netRevenue : 0;
        itemFinancialAllocation.set(item.id, {
          payout: finance.payout * share,
          commission: finance.commission * share,
          marketplaceLogistics: finance.marketplaceLogistics * share,
          otherMarketplaceDeductions: finance.otherMarketplaceDeductions * share,
        });
      }
    }
    const allPaidItems = (periodItems as ItemWithOrderAndCosts[]).filter((item) => this.state(item) === 'PAID');
    const totalPaidRevenue = allPaidItems.reduce((sum, item) => sum + netItemRevenue(item), 0);
    const unallocatedAdvertisingResidual = totalPaidRevenue > 0
      ? 0
      : unallocatedOrderBoostExpense + topPromotionExpense;
    const productRows: Array<{
      product: typeof products[number] | null;
      items: ItemWithOrderAndCosts[];
      isUnallocatedBucket: boolean;
    }> = products.map((product) => ({
      product,
      items: itemsByProductId.get(product.id) ?? [],
      isUnallocatedBucket: false,
    }));
    if (unmatchedItems.length || Math.abs(unallocatedAdvertisingResidual) > 0.001) {
      productRows.push({ product: null, items: unmatchedItems, isUnallocatedBucket: true });
    }
    const advertisingDateLagElapsed = advertisingExpensePublicationCutoff.getTime() <= Date.now();
    const advertisingMayBeIncomplete = !advertisingDateLagElapsed || !expenseSyncWatermark;

    return productRows.map(({ product, items, isUnallocatedBucket }) => {
      const paid = items.filter((item) => this.state(item) === 'PAID');
      const waiting = items.filter((item) => this.state(item) === 'WAITING');
      const active = items.filter((item) => ['PAID', 'WAITING', 'OTHER'].includes(this.state(item)));
      const orderKeys = (rows: ItemWithOrderAndCosts[]) => new Set(rows.map((item) => item.order.marketplaceOrderId || item.order.externalId)).size;

      const totals = paid.reduce((sum, item) => {
        const netRatio = item.quantity > 0
          ? Math.max(0, item.quantity - Math.max(0, item.returns)) / item.quantity
          : 0;
        const itemRevenue = netItemRevenue(item);
        const grossCosts = this.costParts(item);
        const costs = {
          productCost: grossCosts.productCost * netRatio,
          packagingCost: grossCosts.packagingCost * netRatio,
          warehouseLogisticsCost: grossCosts.warehouseLogisticsCost * netRatio,
          additionalCost: grossCosts.additionalCost * netRatio,
        };
        const orderFinance = itemFinancialAllocation.get(item.id)
          ?? { payout: 0, commission: 0, marketplaceLogistics: 0, otherMarketplaceDeductions: 0 };
        sum.revenue += itemRevenue;
        sum.payout += orderFinance.payout;
        sum.commission += orderFinance.commission;
        sum.marketplaceLogistics += orderFinance.marketplaceLogistics;
        sum.otherMarketplaceDeductions += orderFinance.otherMarketplaceDeductions;
        sum.productCost += costs.productCost;
        sum.packagingCost += costs.packagingCost;
        sum.warehouseLogisticsCost += costs.warehouseLogisticsCost;
        sum.additionalCost += costs.additionalCost;
        sum.tax += itemRevenue * taxPercent / 100;
        sum.paidUnits += Math.max(0, item.quantity - Math.max(0, item.returns));
        return sum;
      }, {
        revenue: 0, payout: 0, commission: 0, marketplaceLogistics: 0, otherMarketplaceDeductions: 0,
        productCost: 0, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0,
        tax: 0, advertising: 0, paidUnits: 0,
      });

      const productExternalId = product?.externalId ?? null;
      const linkedOrderBoost = productExternalId ? orderBoostByProduct.get(productExternalId) ?? 0 : 0;
      const allocatedUnlinkedOrderBoost = totalPaidRevenue > 0 ? unallocatedOrderBoostExpense * totals.revenue / totalPaidRevenue : 0;
      const allocatedTopPromotion = totalPaidRevenue > 0 ? topPromotionExpense * totals.revenue / totalPaidRevenue : 0;
      const residualAdvertising = isUnallocatedBucket ? unallocatedAdvertisingResidual : 0;
      totals.advertising = linkedOrderBoost + allocatedUnlinkedOrderBoost + allocatedTopPromotion + residualAdvertising;
      const hasDirectAdvertising = Boolean(productExternalId && productsWithDirectOrderBoost.has(productExternalId));
      const hasAllocatedAdvertising = Math.abs(allocatedUnlinkedOrderBoost) > 0.001
        || Math.abs(allocatedTopPromotion) > 0.001
        || Math.abs(residualAdvertising) > 0.001
        || (totals.revenue > 0 && (hasUnallocatedOrderBoostRows || hasTopPromotionRows))
        || (isUnallocatedBucket && totalPaidRevenue === 0 && (hasUnallocatedOrderBoostRows || hasTopPromotionRows));
      const internalCosts = totals.productCost + totals.packagingCost + totals.warehouseLogisticsCost + totals.additionalCost;
      const profit = totals.payout - internalCosts - totals.tax - totals.advertising;
      const waitingUnits = waiting.reduce((total, item) => total + item.quantity, 0);
      const orderedUnits = active.reduce((total, item) => total + item.quantity, 0);
      const missingSoldCostItems = paid.filter((item) => (
        Math.max(0, item.quantity - Math.max(0, item.returns)) > 0 && !item.sku?.costs?.length
      )).length;
      const missingCosts = product
        ? product.skus.filter((sku) => !sku.costs.length).length
        : missingSoldCostItems;
      const payoutPendingOrders = paid.filter((item) => !item.order.payoutReported).length;
      const profitKnown = !advertisingMayBeIncomplete && missingSoldCostItems === 0 && payoutPendingOrders === 0;

      return {
        id: product?.id ?? '__UNALLOCATED__',
        externalId: productExternalId ?? 'UNALLOCATED',
        title: product?.title ?? 'Не сопоставлено с товаром / нераспределённые расходы',
        imageUrl: product?.imageUrl ?? null,
        isUnallocatedBucket,
        skuCount: product?.skus.length ?? 0,
        missingCosts,
        missingSoldCostItems,
        payoutPendingOrders,
        profitKnown,
        advertisingMayBeIncomplete,
        stock: (product?.skus ?? []).reduce((total, sku) => total + sku.stock, 0),
        orders: orderKeys(active),
        paidOrders: orderKeys(paid),
        waitingOrders: orderKeys(waiting),
        orderedUnits,
        paidUnits: totals.paidUnits,
        waitingUnits,
        revenue: totals.revenue,
        payout: totals.payout,
        commission: totals.commission,
        commissionPercent: totals.revenue ? totals.commission / totals.revenue * 100 : 0,
        marketplaceLogistics: totals.marketplaceLogistics,
        otherMarketplaceDeductions: totals.otherMarketplaceDeductions,
        productCost: totals.productCost,
        packagingCost: totals.packagingCost,
        warehouseLogisticsCost: totals.warehouseLogisticsCost,
        additionalCost: totals.additionalCost,
        advertising: totals.advertising,
        tax: totals.tax,
        profit,
        margin: totals.revenue ? profit / totals.revenue * 100 : 0,
        adRatio: totals.revenue ? totals.advertising / totals.revenue * 100 : 0,
        advertisingSource: hasDirectAdvertising && hasAllocatedAdvertising
          ? 'UZUM_EXPENSE_WITH_ALLOCATION'
          : hasDirectAdvertising
            ? 'UZUM_EXPENSE_DIRECT'
            : hasAllocatedAdvertising
              ? 'UZUM_EXPENSE_ALLOCATED'
              : 'NOT_OBSERVED',
        advertisingBreakdown: {
          linkedOrderBoost,
          allocatedUnlinkedOrderBoost,
          allocatedTopPromotion,
          unallocatedAdvertisingResidual: residualAdvertising,
          allocationBasis: totalPaidRevenue > 0 ? 'PAID_REVENUE_SHARE' : 'UNALLOCATED_STORE_RESIDUAL',
        },
        taxPercent,
        skus: (product?.skus ?? []).map((sku) => {
          const cost = sku.costs[0];
          return {
            id: sku.id,
            sellerSku: sku.sellerSku,
            barcode: sku.barcode,
            color: sku.color,
            size: sku.size,
            stock: sku.stock,
            price: Number(sku.price || 0),
            cost: cost ? Number(cost.amount) + Number(cost.packagingCost) + Number(cost.warehouseLogisticsCost) + Number(cost.additionalCost) : 0,
          };
        }),
      };
    }).filter((product) => {
      const needle = String(search || '').trim().toLocaleLowerCase('ru-RU');
      return !needle || [product.title, product.externalId, ...product.skus.map((sku) => sku.sellerSku)]
        .some((value) => String(value || '').toLocaleLowerCase('ru-RU').includes(needle));
    }).sort((a, b) => b.revenue - a.revenue);
  }
}
