import { BadRequestException, Injectable } from '@nestjs/common';
import { latestAdvertisingRates } from '../../common/advertising';
import { PrismaService } from '../../common/prisma.service';
import { selectCurrentSkuPayout, SkuPayoutObservation } from '../../common/sku-payout';

@Injectable()
export class CostsService {
  constructor(private prisma: PrismaService) {}

  private async activeShop() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Активный магазин не найден');
    return shop;
  }

  async list(search?: string) {
    const shop = await this.activeShop();
    const settings = await this.prisma.financialSettings.findUnique({ where: { shopId: shop.id } });
    const taxPercent = Number(settings?.taxPercent ?? 1);
    const marketplaceCommissionFallbackPercent = Number(settings?.marketplaceCommissionFallbackPercent ?? 0);
    const rows = await this.prisma.sku.findMany({
      where: {
        product: { shopId: shop.id },
        ...(search ? { OR: [
          { sellerSku: { contains: search, mode: 'insensitive' as const } },
          { barcode: { contains: search, mode: 'insensitive' as const } },
          { product: { title: { contains: search, mode: 'insensitive' as const } } },
        ] } : {}),
      },
      include: { product: true, costs: { where: { validTo: null }, orderBy: { validFrom: 'desc' }, take: 1 } },
      orderBy: [{ product: { title: 'asc' } }, { sellerSku: 'asc' }],
    });
    const supplyItems = await this.prisma.supplyItem.findMany({
      where: { skuId: { in: rows.map((sku) => sku.id) }, supply: { logisticsCost: { gt: 0 } } },
      include: { supply: { include: { items: true } } },
    });
    const recentBoostExpenses = await this.prisma.marketplaceExpense.findMany({
      where: {
        shopId: shop.id,
        code: 'У000120',
        type: 'OUTCOME',
        productExternalId: { not: null },
        serviceAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      select: { id: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
    });
    const advertisingRates = latestAdvertisingRates(recentBoostExpenses);
    const supplyAllocation = new Map<string, { amount: number; units: number }>();
    for (const item of supplyItems) {
      if (!item.skuId) continue;
      const supplyUnits = item.supply.items.reduce((sum, row) => sum + (row.acceptedQuantity || row.plannedQuantity), 0);
      const units = item.acceptedQuantity || item.plannedQuantity;
      if (!supplyUnits || !units) continue;
      const current = supplyAllocation.get(item.skuId) || { amount: 0, units: 0 };
      current.amount += Number(item.supply.logisticsCost) * units / supplyUnits;
      current.units += units;
      supplyAllocation.set(item.skuId, current);
    }
    const orderItems = await this.prisma.orderItem.findMany({
      where: { skuId: { in: rows.map((sku) => sku.id) }, order: { payoutReported: true, state: { not: 'CANCELED' } } },
      include: { order: true },
      orderBy: { order: { dateIssued: 'desc' } },
      take: 5000,
    });
    const payoutBySku = new Map<string, SkuPayoutObservation[]>();
    for (const item of orderItems) {
      if (!item.skuId || !item.quantity) continue;
      const orderGross = Number(item.order.grossRevenue);
      const orderPayout = Number(item.order.payout);
      const itemGross = Number(item.amount);
      if (orderGross <= 0 || orderPayout <= 0 || orderPayout > orderGross || itemGross <= 0) continue;
      const current = payoutBySku.get(item.skuId) || [];
      current.push({ issuedAt: item.order.dateIssued, itemGross, orderGross, orderPayout, quantity: item.quantity });
      payoutBySku.set(item.skuId, current);
    }
    return rows.map((sku) => {
      const price = Number(sku.price || 0);
      const cost = Number(sku.costs[0]?.amount || 0);
      const packagingCost = Number(sku.costs[0]?.packagingCost || 0);
      const allocated = supplyAllocation.get(sku.id);
      const warehouseLogisticsCost = allocated?.units ? allocated.amount / allocated.units : Number(sku.costs[0]?.warehouseLogisticsCost || 0);
      const additionalCost = Number(sku.costs[0]?.additionalCost || 0);
      const taxEstimate = price * taxPercent / 100;
      const advertisingRate = advertisingRates.get(sku.product.externalId);
      const orderBoostEnabled = Boolean(advertisingRate);
      const skuAdvertisingPercent = advertisingRate?.percent ?? null;
      const advertisingEstimate = advertisingRate ? price * advertisingRate.percent / 100 : null;
      const marketplaceCommissionEstimate = 0;
      const payout = selectCurrentSkuPayout(price, payoutBySku.get(sku.id) || [], marketplaceCommissionFallbackPercent);
      const sellerPayout = payout.amount;
      const fullCostEstimate = advertisingEstimate === null
        ? null
        : cost + packagingCost + warehouseLogisticsCost + additionalCost + taxEstimate + advertisingEstimate;
      return {
        id: sku.id,
        externalId: sku.externalId,
        sellerSku: sku.sellerSku,
        barcode: sku.barcode,
        product: sku.product.title,
        color: sku.color,
        size: sku.size,
        stock: sku.stock,
        price,
        cost,
        packagingCost,
        warehouseLogisticsCost,
        additionalCost,
        taxEstimate,
        advertisingEstimate,
        advertisingPercent: skuAdvertisingPercent,
        advertisingObservedAt: advertisingRate?.observedAt ?? null,
        advertisingSource: advertisingRate ? 'UZUM_EXPENSE' : 'NOT_OBSERVED',
        orderBoostEnabled,
        marketplaceCommissionEstimate,
        sellerPayout,
        sellerPayoutTotal: sellerPayout * Math.max(0, sku.stock),
        sellerPayoutSource: payout.source,
        sellerPayoutSourcePrice: payout.sourcePrice,
        sellerPayoutSourceIssuedAt: payout.sourceIssuedAt,
        logisticsFromSupplies: Boolean(allocated?.units),
        fullCostEstimate,
        marginEstimate: fullCostEstimate === null ? null : sellerPayout - fullCostEstimate,
        marginEstimateKnown: fullCostEstimate !== null,
      };
    });
  }

  async getSettings() {
    const shop = await this.activeShop();
    const settings = await this.prisma.financialSettings.upsert({
      where: { shopId: shop.id },
      update: {},
      create: { shopId: shop.id, taxPercent: 1, advertisingPercent: 0, marketplaceCommissionFallbackPercent: 0, payoutDelayDays: 10, payoutSchedule: 'BIWEEKLY', payoutServiceFeePercent: 0, urgentWithdrawalFeePercent: 2.5 },
    });
    return {
      taxPercent: Number(settings.taxPercent),
      advertisingPercent: 0,
      advertisingMode: 'UZUM_PRODUCT_FACT',
      marketplaceCommissionFallbackPercent: Number(settings.marketplaceCommissionFallbackPercent),
      payoutDelayDays: Number(settings.payoutDelayDays),
      payoutSchedule: String((settings as any).payoutSchedule || 'BIWEEKLY'),
      payoutServiceFeePercent: Number((settings as any).payoutServiceFeePercent ?? 0),
      urgentWithdrawalFeePercent: Number((settings as any).urgentWithdrawalFeePercent ?? 2.5),
    };
  }

  async saveSettings(input: { taxPercent: number; marketplaceCommissionFallbackPercent: number; payoutDelayDays: number; payoutSchedule?: string; payoutServiceFeePercent?: number; urgentWithdrawalFeePercent?: number }) {
    const shop = await this.activeShop();
    const data = { ...input, advertisingPercent: 0 };
    const settings = await this.prisma.financialSettings.upsert({
      where: { shopId: shop.id },
      update: data,
      create: { shopId: shop.id, ...data },
    });
    return {
      taxPercent: Number(settings.taxPercent),
      advertisingPercent: 0,
      advertisingMode: 'UZUM_PRODUCT_FACT',
      marketplaceCommissionFallbackPercent: Number(settings.marketplaceCommissionFallbackPercent),
      payoutDelayDays: Number(settings.payoutDelayDays),
      payoutSchedule: String((settings as any).payoutSchedule || 'BIWEEKLY'),
      payoutServiceFeePercent: Number((settings as any).payoutServiceFeePercent ?? 0),
      urgentWithdrawalFeePercent: Number((settings as any).urgentWithdrawalFeePercent ?? 2.5),
    };
  }

  async saveBulk(items: { skuId: string; amount: number; packagingCost?: number; warehouseLogisticsCost?: number; additionalCost?: number }[]) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        await tx.skuCost.updateMany({ where: { skuId: item.skuId, validTo: null }, data: { validTo: now } });
        await tx.skuCost.create({
          data: {
            skuId: item.skuId,
            amount: item.amount,
            packagingCost: item.packagingCost || 0,
            warehouseLogisticsCost: item.warehouseLogisticsCost || 0,
            additionalCost: item.additionalCost || 0,
            validFrom: now,
          },
        });
      }
    });
    return { saved: items.length };
  }
}
