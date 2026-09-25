import { describe, expect, it } from 'vitest';
import { buildProfitDays } from '../profit-days';

describe('buildProfitDays', () => {
  it('reconciles daily profit from already attributed advertising', () => {
    const from = new Date('2026-08-09T00:00:00+05:00');
    const to = new Date('2026-08-10T23:59:59+05:00');
    const result = buildProfitDays(from, to, [{
      date: from, revenue: 1_000, units: 2, payout: 700, productCost: 200,
      packagingAndAdditional: 20, marketplaceLogistics: 100, warehouseLogistics: 30, tax: 10,
    }], [{ date: from, revenue: 900, units: 2 }], [{ date: from, amount: 40 }]);

    const day = result.days.find((row) => row.date === '2026-08-09')!;
    expect(day.advertising).toBe(40);
    expect(day.purchasedRevenue).toBe(900);
    expect(day.profit).toBe(400);
    expect(result.summary.marginPercent).toBe(40);
  });

  it('subtracts order-unrelated Uzum fees (storage, warehouse fines) from profit', () => {
    const from = new Date('2026-08-09T00:00:00+05:00');
    const to = new Date('2026-08-09T23:59:59+05:00');
    const result = buildProfitDays(from, to, [{
      date: from, revenue: 1_000, units: 2, payout: 700, productCost: 200,
      packagingAndAdditional: 20, marketplaceLogistics: 100, warehouseLogistics: 30, tax: 10,
    }], [], [{ date: from, amount: 40 }], [], [{ date: from, amount: 25 }]);

    const day = result.days[0];
    expect(day.otherFees).toBe(25);
    expect(day.expensesExAdvertising).toBe(200 + 20 + 30 + 10 + 25);
    expect(day.profit).toBe(700 - (200 + 20 + 30 + 10 + 25) - 40);
    expect(result.summary.otherFees).toBe(25);
  });
});
