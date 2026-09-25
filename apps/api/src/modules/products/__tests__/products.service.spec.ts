import { describe, expect, it, vi } from 'vitest';
import { ProductsService } from '../products.service';

const settings = {
  taxPercent: 0,
  advertisingPercent: 0,
  marketplaceCommissionFallbackPercent: 0,
};

function product(id: string, externalId: string) {
  return {
    id,
    externalId,
    title: `Product ${externalId}`,
    imageUrl: null,
    skus: [{ id: `sku-${id}`, sellerSku: `seller-${id}`, barcode: null, color: null, size: null, stock: 0, price: 100, costs: [] }],
  };
}

function prisma(products: any[], items: any[], expenses: any[] = [], expenseSyncWatermark: any = null) {
  return {
    shop: { findFirst: vi.fn().mockResolvedValue({ id: 'shop' }) },
    financialSettings: { upsert: vi.fn().mockResolvedValue(settings) },
    product: { findMany: vi.fn().mockResolvedValue(products) },
    marketplaceExpense: { findMany: vi.fn().mockResolvedValue(expenses) },
    orderItem: { findMany: vi.fn().mockResolvedValue(items) },
    syncRun: { findFirst: vi.fn().mockResolvedValue(expenseSyncWatermark) },
  } as any;
}

describe('ProductsService reconciliation', () => {
  it('allocates a multi-item payout by net revenue after a partial return', async () => {
    const products = [product('a', 'A'), product('b', 'B')];
    const order = {
      id: 'order', externalId: 'order', marketplaceOrderId: 'parent', state: 'PAID', status: 'PAID',
      paidAt: new Date('2026-01-10'), dateIssued: new Date('2026-01-10'), grossRevenue: 200,
      payout: 80, commission: 0, logistics: 0,
      payoutReported: true, commissionReported: true, logisticsReported: true,
    };
    const items = [
      { id: 'item-a', orderId: order.id, order, skuId: 'sku-a', marketplaceProductId: 'A', title: 'A', quantity: 1, returns: 1, amount: 100, raw: {}, sku: { productId: 'a', costs: [] } },
      { id: 'item-b', orderId: order.id, order, skuId: 'sku-b', marketplaceProductId: 'B', title: 'B', quantity: 1, returns: 0, amount: 100, raw: {}, sku: { productId: 'b', costs: [] } },
    ];

    const rows = await new ProductsService(prisma(products, items)).list(undefined, { from: '2026-01-10', to: '2026-01-10' });

    expect(rows.find((row) => row.externalId === 'A')).toMatchObject({ revenue: 0, payout: 0, paidUnits: 0 });
    expect(rows.find((row) => row.externalId === 'B')).toMatchObject({ revenue: 100, payout: 80, paidUnits: 1 });
  });

  it('recovers an item without skuId through marketplaceProductId', async () => {
    const products = [product('a', 'A')];
    const order = {
      id: 'order', externalId: 'order', marketplaceOrderId: 'parent', state: 'PAID', status: 'PAID',
      paidAt: new Date('2026-01-10'), dateIssued: new Date('2026-01-10'), grossRevenue: 100,
      payout: 80, commission: 0, logistics: 0,
      payoutReported: true, commissionReported: true, logisticsReported: true,
    };
    const items = [{
      id: 'orphan', orderId: order.id, order, skuId: null, marketplaceProductId: 'A', title: 'A',
      quantity: 1, returns: 0, amount: 100, raw: {}, sku: null,
    }];

    const rows = await new ProductsService(prisma(products, items)).list(undefined, { from: '2026-01-10', to: '2026-01-10' });

    expect(rows.find((row) => row.externalId === 'A')).toMatchObject({ revenue: 100, payout: 80, missingSoldCostItems: 1 });
    expect(rows.some((row) => row.isUnallocatedBucket)).toBe(false);
  });

  it('returns a store-level residual when advertising exists without paid revenue', async () => {
    const expenses = [
      { code: 'У000119', productExternalId: null, amount: 38_633 },
      { code: 'return-У000119', productExternalId: null, amount: -8_633 },
    ];

    const rows = await new ProductsService(prisma([product('a', 'A')], [], expenses)).list(undefined, { from: '2025-09-19', to: '2025-09-19' });
    const residual = rows.find((row) => row.isUnallocatedBucket);

    expect(residual).toBeDefined();
    expect(residual).toMatchObject({ revenue: 0, advertising: 30_000, profit: -30_000 });
    expect(residual!.advertisingBreakdown).toMatchObject({
      unallocatedAdvertisingResidual: 30_000,
      allocationBasis: 'UNALLOCATED_STORE_RESIDUAL',
    });
  });

  it('does not finalize old-period profit without a post-lag successful FULL sync watermark', async () => {
    const products = [product('a', 'A')];
    const order = {
      id: 'order', externalId: 'order', marketplaceOrderId: 'parent', state: 'PAID', status: 'PAID',
      paidAt: new Date('2026-01-10'), dateIssued: new Date('2026-01-10'), grossRevenue: 100,
      payout: 80, commission: 0, logistics: 0,
      payoutReported: true, commissionReported: true, logisticsReported: true,
    };
    const items = [{
      id: 'item', orderId: order.id, order, skuId: 'sku-a', marketplaceProductId: 'A', title: 'A',
      quantity: 1, returns: 0, amount: 100, raw: {},
      sku: {
        productId: 'a',
        costs: [{ amount: 20, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0 }],
      },
    }];
    const db = prisma(products, items);

    const rows = await new ProductsService(db).list(undefined, { from: '2026-01-10', to: '2026-01-10' });

    expect(rows.find((row) => row.externalId === 'A')).toMatchObject({
      profitKnown: false,
      advertisingMayBeIncomplete: true,
    });
    expect(db.syncRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        shopId: 'shop',
        type: 'FULL',
        status: 'SUCCESS',
        startedAt: { gte: new Date('2026-01-11T18:59:59.999Z') },
        finishedAt: { not: null },
      }),
    }));
  });

  it('finalizes old-period profit after a successful FULL sync starts beyond the publication lag', async () => {
    const products = [product('a', 'A')];
    const order = {
      id: 'order', externalId: 'order', marketplaceOrderId: 'parent', state: 'PAID', status: 'PAID',
      paidAt: new Date('2026-01-10'), dateIssued: new Date('2026-01-10'), grossRevenue: 100,
      payout: 80, commission: 0, logistics: 0,
      payoutReported: true, commissionReported: true, logisticsReported: true,
    };
    const items = [{
      id: 'item', orderId: order.id, order, skuId: 'sku-a', marketplaceProductId: 'A', title: 'A',
      quantity: 1, returns: 0, amount: 100, raw: {},
      sku: {
        productId: 'a',
        costs: [{ amount: 20, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0 }],
      },
    }];
    const watermark = {
      id: 'full-sync',
      finishedAt: new Date('2026-01-12T01:00:00.000Z'),
    };

    const rows = await new ProductsService(prisma(products, items, [], watermark)).list(undefined, { from: '2026-01-10', to: '2026-01-10' });

    expect(rows.find((row) => row.externalId === 'A')).toMatchObject({
      profitKnown: true,
      advertisingMayBeIncomplete: false,
    });
  });
});
