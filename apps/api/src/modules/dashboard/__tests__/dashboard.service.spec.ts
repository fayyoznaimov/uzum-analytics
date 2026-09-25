import { describe, expect, it, vi } from 'vitest';
import { advertisingEstimateAt, advertisingRateTimeline } from '../../../common/advertising';
import { DashboardService } from '../dashboard.service';

describe('DashboardService partial returns', () => {
  it('keeps reported payout and fees while reducing unit-based revenue once', () => {
    const service = new DashboardService({} as any);
    const order = {
      dateIssued: new Date('2026-07-23T13:17:44.841Z'),
      grossRevenue: 120_000,
      payout: 41_050,
      commission: 13_200,
      logistics: 5_750,
      payoutReported: true,
      commissionReported: true,
      logisticsReported: true,
      adCost: 0,
      adCostReported: false,
      returnAmount: 0,
      returnedUnits: 1,
      items: [{ quantity: 2, sku: { costs: [] } }],
    };

    const result = (service as any).financials(order, 1, 3, 0);

    expect(result.gross).toBe(60_000);
    expect(result.payout).toBe(41_050);
    expect(result.commission).toBe(13_200);
    expect(result.marketplaceLogistics).toBe(5_750);
    expect(result.payoutCalculated).toBe(41_050);
    expect(result.payoutDifference).toBe(0);
    expect(result.tax).toBe(600);
    expect(result.advertising).toBe(1_800);
    expect(result.profit).toBe(38_650);
    expect(result.returnReserve).toBe(0);
  });

  it('does not prorate a reported advertising charge on a partial return', () => {
    const service = new DashboardService({} as any);
    const order = {
      dateIssued: new Date('2026-07-23T13:17:44.841Z'),
      grossRevenue: 120_000,
      payout: 41_050,
      commission: 13_200,
      logistics: 5_750,
      payoutReported: true,
      commissionReported: true,
      logisticsReported: true,
      adCost: 2_000,
      adCostReported: true,
      returnAmount: 0,
      returnedUnits: 1,
      items: [{ quantity: 2, sku: { costs: [] } }],
    };

    const result = (service as any).financials(order, 1, 3, 0);

    expect(result.advertising).toBe(2_000);
    expect(result.profit).toBe(38_450);
  });
});

describe('DashboardService advertising-rate backfill', () => {
  it('uses a U000120 rate dated by display day even when Uzum publishes it later', async () => {
    const expenses = [
      {
        id: 'old-3',
        productExternalId: '2880108',
        serviceAt: new Date('2026-08-15T10:00:00+05:00'),
        createdAt: new Date('2026-08-15T10:01:00+05:00'),
        name: 'Sotuvdan foiz - 3%. Namoyish - 2026-08-14',
        raw: {},
      },
      {
        id: 'late-6',
        productExternalId: '2880108',
        serviceAt: new Date('2026-08-17T10:00:00+05:00'),
        createdAt: new Date('2026-08-17T10:01:00+05:00'),
        name: 'Sotuvdan foiz - 6%. Namoyish - 2026-08-15',
        raw: {},
      },
    ];
    const findMany = vi.fn(async ({ where }: any) => expenses.filter((expense) => (
      expense.serviceAt >= where.serviceAt.gte && expense.serviceAt <= where.serviceAt.lte
    )));
    const service = new DashboardService({ marketplaceExpense: { findMany } } as any);
    const from = new Date('2026-08-15T00:00:00+05:00');
    const to = new Date('2026-08-15T23:59:59.999+05:00');
    const now = new Date('2026-08-19T12:00:00+05:00');

    const loaded = await (service as any).loadProductAdvertisingExpenses('shop-1', from, to, now);
    const estimate = advertisingEstimateAt(
      [{ productExternalId: '2880108', amount: 100_000 }],
      advertisingRateTimeline(loaded),
      new Date('2026-08-15T12:00:00+05:00'),
    );

    expect(findMany.mock.calls[0][0].where.serviceAt.lte).toEqual(now);
    expect(loaded.map((expense: any) => expense.id)).toContain('late-6');
    expect(estimate).toMatchObject({ amount: 6_000, coveredRevenue: 100_000 });
  });
});
