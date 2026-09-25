import { describe, expect, it, vi } from 'vitest';
import { CostsService } from '../costs.service';

describe('CostsService advertising rates', () => {
  it('uses the latest factual rate per product and marks an unobserved rate unknown', async () => {
    const product = (externalId: string) => ({ externalId, title: `Product ${externalId}` });
    const sku = (id: string, externalId: string, price: number) => ({
      id,
      externalId: `sku-${id}`,
      sellerSku: `seller-${id}`,
      barcode: null,
      color: null,
      size: null,
      stock: 1,
      price,
      product: product(externalId),
      costs: [],
    });
    const prisma = {
      shop: { findFirst: vi.fn().mockResolvedValue({ id: 'shop' }) },
      financialSettings: { findUnique: vi.fn().mockResolvedValue({ taxPercent: 1, marketplaceCommissionFallbackPercent: 0 }) },
      sku: { findMany: vi.fn().mockResolvedValue([sku('a', 'A', 100_000), sku('b', 'B', 200_000), sku('c', 'C', 300_000)]) },
      supplyItem: { findMany: vi.fn().mockResolvedValue([]) },
      marketplaceExpense: { findMany: vi.fn().mockResolvedValue([
        { productExternalId: 'A', serviceAt: new Date(Date.now() - 2_000), name: 'Sotuvdan foiz — 3%', raw: null },
        { productExternalId: 'A', serviceAt: new Date(Date.now() - 1_000), name: 'Sotuvdan foiz — 6%', raw: null },
        { productExternalId: 'B', serviceAt: new Date(Date.now() - 1_000), name: 'Процент за продажу — 5%', raw: null },
      ]) },
      orderItem: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const rows = await new CostsService(prisma).list();

    expect(rows.map((row) => ({ product: row.product, percent: row.advertisingPercent, amount: row.advertisingEstimate }))).toEqual([
      { product: 'Product A', percent: 6, amount: 6_000 },
      { product: 'Product B', percent: 5, amount: 10_000 },
      { product: 'Product C', percent: null, amount: null },
    ]);
    expect(rows.find((row) => row.product === 'Product C')?.marginEstimateKnown).toBe(false);
  });
});
