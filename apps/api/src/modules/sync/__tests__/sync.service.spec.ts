import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../sync.service';

function orderSyncPrisma(overrides: Record<string, any> = {}) {
  const prisma = {
    ...overrides,
    order: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'order-db' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      ...(overrides.order || {}),
    },
    financialSettings: { findUnique: vi.fn().mockResolvedValue(null), ...(overrides.financialSettings || {}) },
    marketplaceExpense: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      ...(overrides.marketplaceExpense || {}),
    },
    orderStatusHistory: { create: vi.fn().mockResolvedValue({}), ...(overrides.orderStatusHistory || {}) },
    orderFinancialEvent: { upsert: vi.fn().mockResolvedValue({}), ...(overrides.orderFinancialEvent || {}) },
    sku: { findFirst: vi.fn().mockResolvedValue(null), ...(overrides.sku || {}) },
    skuCost: { findFirst: vi.fn().mockResolvedValue(null), ...(overrides.skuCost || {}) },
    orderItem: {
      upsert: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 0 } }),
      ...(overrides.orderItem || {}),
    },
  } as any;
  prisma.$transaction = overrides.$transaction || vi.fn(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return prisma;
}

describe('SyncService order reconciliation fields', () => {
  it('sends a daily per-product advertising-rate digest without a global fallback', async () => {
    const prisma = orderSyncPrisma({
      shop: { findFirst: vi.fn().mockResolvedValue({ id: 'shop-db', name: 'ParisaHome' }) },
      product: { findMany: vi.fn().mockResolvedValue([
        { externalId: 'known', title: 'Known towel' },
        { externalId: 'unknown', title: 'Unknown towel' },
      ]) },
      marketplaceExpense: { findMany: vi.fn().mockResolvedValue([{
        id: 'rate-1', productExternalId: 'known', serviceAt: new Date(), createdAt: new Date(),
        name: 'Sotuvdan foiz — 6%', raw: { promotionPercent: 6 },
      }]) },
    });
    const integrations = { notifyTelegram: vi.fn().mockResolvedValue(true) };
    const service = new SyncService(prisma, integrations as any);

    await service.sendDailyAdvertisingRateDigest();

    const message = integrations.notifyTelegram.mock.calls[0][0];
    expect(message).toContain('Known towel: 6%');
    expect(message).toContain('Unknown towel: ставка не наблюдалась');
    expect(integrations.notifyTelegram).toHaveBeenCalledWith(expect.any(String), 'notifyDailyDigest');
  });

  it('retries a transient successful response with an unrecognized shape', async () => {
    vi.useFakeTimers();
    try {
      const service = new SyncService(orderSyncPrisma(), {} as any);
      (service as any).request = vi.fn()
        .mockResolvedValueOnce({ timestamp: Date.now(), message: 'temporary upstream response' })
        .mockResolvedValueOnce({ orderItems: [{ id: 'order-item' }], totalElements: 1 });

      const pending = (service as any).requestRequiredArray(
        '/v1/finance/orders',
        'token',
        { page: 0, size: 100, shopIds: '92776' },
        ['orderItems'],
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({ rows: [{ id: 'order-item' }] });
      expect((service as any).request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the matched product id rather than confusing it with the SKU id', async () => {
    const prisma = orderSyncPrisma({
      sku: { findFirst: vi.fn().mockResolvedValue({ id: 'sku-db', externalId: '9074686', product: { externalId: '101' } }) },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      orderItems: [{
        id: 'item-1', orderId: 'order-1', status: 'PROCESSING', date: '2026-07-01T10:00:00Z',
        amount: 1, sellPrice: 89_000, skuTitle: 'FAYYOZ-HAVANA-ЗЕЛХАКИ-70 x140',
      }],
    });

    await (service as any).syncOrders('shop-db', '92776', 'token');

    const input = prisma.orderItem.upsert.mock.calls[0][0];
    expect(input.update.marketplaceProductId).toBe('101');
    expect(input.create.marketplaceProductId).toBe('101');
  });

  it('does not overwrite a statement SKU id when neither API id nor SKU match is available', async () => {
    const prisma = orderSyncPrisma();
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      orderItems: [{
        id: 'item-2', orderId: 'order-2', status: 'PROCESSING', date: '2026-07-01T10:00:00Z',
        amount: 1, sellPrice: 60_000, skuTitle: 'HISTORICAL-SKU',
      }],
    });

    await (service as any).syncOrders('shop-db', '92776', 'token');

    const input = prisma.orderItem.upsert.mock.calls[0][0];
    expect(input.update).not.toHaveProperty('marketplaceProductId');
    expect(input.create.marketplaceProductId).toBeNull();
  });

  it('preserves authoritative advertising fields while refreshing finance/orders', async () => {
    const existing = {
      id: 'order-db', quantity: 1, returnedUnits: 0, payout: 50_000,
      issuedAt: null, dateIssued: new Date('2026-07-01T10:00:00Z'),
      state: 'WAITING', status: 'PROCESSING', adCost: 6_000, adCostReported: true,
    };
    const prisma = orderSyncPrisma({
      order: {
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert: vi.fn().mockResolvedValue(existing),
      },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      orderItems: [{
        id: 'item-preserve-ad', orderId: 'order-preserve-ad', status: 'PROCESSING',
        date: '2026-07-01T10:00:00Z', amount: 1, sellPrice: 100_000, sellerProfit: 50_000,
        skuTitle: 'SKU',
      }],
    });

    await (service as any).syncOrders('shop-db', '92776', 'token');

    const update = prisma.order.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty('adCost');
    expect(update).not.toHaveProperty('adCostReported');
  });

  it('does not erase previously reported finance fields when a fast response omits them', async () => {
    const existing = {
      id: 'order-db', quantity: 1, returnedUnits: 0, payout: 50_000,
      commission: 12_000, logistics: 5_000, grossRevenue: 100_000,
      payoutReported: true, commissionReported: true, logisticsReported: true,
      issuedAt: null, orderedAt: new Date('2026-07-01T10:00:00Z'),
      dateIssued: new Date('2026-07-01T10:00:00Z'), state: 'WAITING', status: 'PROCESSING',
    };
    const prisma = orderSyncPrisma({
      order: {
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert: vi.fn().mockResolvedValue(existing),
      },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      orderItems: [{ id: 'item-finance', orderId: 'order-finance', status: 'PROCESSING', amount: 1, skuTitle: 'SKU' }],
    });

    await (service as any).syncOrders('shop-db', '92776', 'token');

    const update = prisma.order.upsert.mock.calls[0][0].update;
    for (const field of ['grossRevenue', 'payout', 'commission', 'logistics', 'payoutReported', 'commissionReported', 'logisticsReported']) {
      expect(update).not.toHaveProperty(field);
    }
  });

  it('uses the latest rate of each product and marks an unknown rate as unknown', async () => {
    const prisma = orderSyncPrisma({
      order: {
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 'order-db' }),
      },
      marketplaceExpense: {
        findMany: vi.fn().mockResolvedValue([{
          productExternalId: 'product-6',
          serviceAt: new Date(),
          name: 'observed product rate',
          raw: { promotionPercent: 6 },
        }]),
      },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).notifyOnce = vi.fn().mockResolvedValue(undefined);
    (service as any).request = vi.fn().mockResolvedValue({
      orderItems: [
        {
          id: 'item-known-rate', orderId: 'order-known-rate', productId: 'product-6',
          status: 'PROCESSING', date: new Date().toISOString(), amount: 1,
          sellPrice: 100_000, sellerProfit: 80_000, skuTitle: 'KNOWN-RATE',
        },
        {
          id: 'item-unknown-rate', orderId: 'order-unknown-rate', productId: 'product-unknown',
          status: 'PROCESSING', date: new Date().toISOString(), amount: 1,
          sellPrice: 100_000, sellerProfit: 80_000, skuTitle: 'UNKNOWN-RATE',
        },
      ],
    });

    await (service as any).syncOrders('shop-db', '92776', 'token');

    const notifications = (service as any).notifyOnce.mock.calls.map((call: any[]) => String(call[2]));
    expect(notifications.find((message: string) => message.includes('KNOWN-RATE'))).toContain('Оценка рекламы по последней наблюдаемой ставке 6%');
    expect(notifications.find((message: string) => message.includes('UNKNOWN-RATE'))).toContain('Реклама: <b>не рассчитана</b>');
    expect(notifications.find((message: string) => message.includes('UNKNOWN-RATE'))).toContain('Потенциальный профит: <b>не рассчитан');
  });

  it('does not create a return reversal for a cancellation before issue', async () => {
    const existing = {
      id: 'order-db', quantity: 1, returnedUnits: 0, payout: 0, issuedAt: null,
      dateIssued: new Date('2026-07-01T10:00:00Z'), state: 'CANCELED', status: 'CANCELED',
    };
    const prisma = orderSyncPrisma({
      order: {
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert: vi.fn().mockResolvedValue(existing),
      },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      orderItems: [{
        id: 'item-cancel', orderId: 'order-cancel', status: 'CANCELED', date: '2026-07-01T10:00:00Z',
        amount: 1, amountReturns: 1, sellPrice: 60_000, sellerProfit: 0,
        returnCause: 'Отменён до получения', comment: 'Передумал', skuTitle: 'SKU',
      }],
    });

    await (service as any).syncOrders('shop-db', '92776', 'token');

    expect(prisma.orderFinancialEvent.upsert).not.toHaveBeenCalled();
  });
});

describe('SyncService expense return transitions', () => {
  it('does not reset advertising costs when the expenses response is incomplete', async () => {
    const prisma = orderSyncPrisma();
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({ payload: { error: 'temporary response' } });

    await expect((service as any).syncExpenses('shop-db', '92776', 'token'))
      .rejects.toThrow('has no payments array');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('allocates parent-order advertising by product and nets signed У000120/У000119 returns', async () => {
    const parentRows = [
      {
        id: 'row-product-101', grossRevenue: 100_000, raw: {},
        items: [{
          amount: 100_000, marketplaceProductId: null, raw: {},
          sku: { product: { externalId: '101' } },
        }],
      },
      {
        id: 'row-product-102', grossRevenue: 200_000, raw: {},
        items: [{
          amount: 200_000, marketplaceProductId: null, raw: {},
          sku: { product: { externalId: '102' } },
        }],
      },
    ];
    const prisma = orderSyncPrisma({
      order: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue(parentRows),
      },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      payload: {
        payments: [
          {
            id: 'ad-product-101', externalId: 'AD#50001-101-20260818', code: 'У000120', type: 'OUTCOME',
            paymentPrice: 100, amount: 1, dateService: '2026-08-18T10:00:00Z',
            name: 'Buyurtma № 50001, tovar IDsi — 101',
          },
          {
            id: 'refund-product-101', externalId: 'CANCELLATION_AD#50001-101-20260818',
            code: 'return-У000120', type: 'OUTCOME', paymentPrice: 20, amount: 1,
            dateService: '2026-08-18T11:00:00Z', name: 'Buyurtma № 50001, tovar IDsi — 101',
          },
          {
            id: 'ad-product-102', externalId: 'AD#50001-102-20260818', code: 'У000120', type: 'OUTCOME',
            paymentPrice: 200, amount: 1, dateService: '2026-08-18T12:00:00Z',
            name: 'Buyurtma № 50001, tovar IDsi — 102',
          },
          {
            id: 'refund-top', externalId: 'CANCELLATION_AD#campaign-92776-20260818',
            code: 'return-У000119', type: 'INCOME', paymentPrice: 30, amount: 1,
            dateService: '2026-08-18T13:00:00Z', name: 'Top promotion refund',
          },
        ],
      },
    });

    await (service as any).syncExpenses('shop-db', '92776', 'token');

    const storedExpenses = prisma.marketplaceExpense.upsert.mock.calls.map((call: any[]) => call[0].create);
    expect(storedExpenses.find((row: any) => row.externalId === 'refund-product-101')).toMatchObject({
      amount: -20,
      orderExternalId: '50001',
      productExternalId: '101',
    });
    expect(storedExpenses.find((row: any) => row.externalId === 'refund-top')).toMatchObject({
      amount: -30,
      campaignExternalId: 'campaign',
    });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { shopId: 'shop-db' },
      data: { adCost: 0, adCostReported: false },
    });
    const allocated = new Map(prisma.order.update.mock.calls.map((call: any[]) => [
      call[0].where.id,
      call[0].data,
    ]));
    expect(allocated).toEqual(new Map([
      ['row-product-101', { adCost: 80, adCostReported: true }],
      ['row-product-102', { adCost: 200, adCostReported: true }],
    ]));
  });

  it('leaves a product-qualified parent expense unallocated instead of charging another product', async () => {
    const prisma = orderSyncPrisma({
      order: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{
          id: 'row-product-102', grossRevenue: 200_000, raw: {},
          items: [{
            amount: 200_000, marketplaceProductId: '102', raw: {},
            sku: { product: { externalId: '102' } },
          }],
        }]),
      },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      payload: {
        payments: [{
          id: 'ad-product-101', externalId: 'AD#50001-101-20260818', code: 'У000120', type: 'OUTCOME',
          paymentPrice: 100, amount: 1, dateService: '2026-08-18T10:00:00Z',
          name: 'Buyurtma № 50001, tovar IDsi — 101',
        }],
      },
    });

    await (service as any).syncExpenses('shop-db', '92776', 'token');

    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { shopId: 'shop-db' },
      data: { adCost: 0, adCostReported: false },
    });
  });

  it('leaves an exact-order product conflict unallocated', async () => {
    const prisma = orderSyncPrisma({
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'exact-row-product-102',
          raw: {},
          items: [{
            marketplaceProductId: '102', raw: {},
            sku: { product: { externalId: '102' } },
          }],
        }),
      },
    });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      payload: {
        payments: [{
          id: 'ad-product-101', externalId: 'AD#exact-order-101-20260818', code: 'У000120', type: 'OUTCOME',
          paymentPrice: 100, amount: 1, dateService: '2026-08-18T10:00:00Z',
          name: 'Buyurtma № exact-order, tovar IDsi — 101',
        }],
      },
    });

    await (service as any).syncExpenses('shop-db', '92776', 'token');

    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { shopId: 'shop-db' },
      data: { adCost: 0, adCostReported: false },
    });
  });

  it('recognizes medium logistics and records a return transition only once', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: 'order-db', state: 'PAID', quantity: 1 }])
      .mockResolvedValueOnce([{ id: 'order-db', state: 'RETURNED', quantity: 1 }]);
    const prisma = orderSyncPrisma({ order: { findMany } });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      payload: {
        payments: [{
          id: 'expense-1', code: 'return-logistics-medium-01', type: 'INCOME',
          paymentPrice: 8_000, amount: 1, dateService: '2026-07-10T10:00:00Z',
          name: 'Buyurtma № 12345 uchun logistika to\'lovini qaytarish',
        }],
      },
    });

    await (service as any).syncExpenses('shop-db', '92776', 'token');
    await (service as any).syncExpenses('shop-db', '92776', 'token');

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(prisma.order.update).toHaveBeenCalledTimes(1);
    expect(prisma.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.orderStatusHistory.create.mock.calls[0][0].data.sourceStatus).toBe('return-logistics-medium-01');
  });

  it('applies mixed parent logistics transitions to the child IDs from the expense ledger', async () => {
    const findUnique = vi.fn().mockImplementation(({ where }: any) => {
      const externalId = where.shopId_externalId.externalId;
      if (externalId === 'child-paid') {
        return Promise.resolve({ id: 'paid-row', state: 'WAITING', quantity: 1, issuedAt: null, paidAt: null });
      }
      if (externalId === 'child-returned') {
        return Promise.resolve({ id: 'returned-row', state: 'PAID', quantity: 1 });
      }
      return Promise.resolve(null);
    });
    const prisma = orderSyncPrisma({ order: { findUnique } });
    const service = new SyncService(prisma, {} as any);
    (service as any).request = vi.fn().mockResolvedValue({
      payload: {
        payments: [
          {
            id: 'fulfilled-expense', externalId: 'event:child-paid', code: 'logistics-volume', type: 'OUTCOME',
            paymentPrice: 5_750, amount: 1, dateService: '2026-08-18T10:00:00Z',
            name: 'Buyurtma № 50001 uchun logistika xizmatlari uchun to\'lov.',
          },
          {
            id: 'returned-expense', externalId: 'event:child-returned', code: 'return-logistics-volume', type: 'INCOME',
            paymentPrice: 5_750, amount: 1, dateService: '2026-08-18T11:00:00Z',
            name: 'Buyurtma № 50001 uchun logistika to\'lovini qaytarish',
          },
        ],
      },
    });

    await (service as any).syncExpenses('shop-db', '92776', 'token');

    expect(findUnique.mock.calls.map((call: any[]) => call[0].where.shopId_externalId.externalId))
      .toEqual(['child-paid', 'child-returned']);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.order.update.mock.calls.map((call: any[]) => [call[0].where.id, call[0].data.state]))
      .toEqual([['paid-row', 'PAID'], ['returned-row', 'RETURNED']]);
  });
});
