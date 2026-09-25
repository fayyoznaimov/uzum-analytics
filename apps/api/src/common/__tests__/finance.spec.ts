import { describe, expect, it } from 'vitest';
import { calculateOrderFinancials } from '../finance';

const costs = { productCost: 300_000, packagingCost: 10_000, warehouseLogisticsCost: 20_000, additionalCost: 5_000 };

describe('financial waterfall', () => {
  it('does not subtract marketplace commission or logistics twice', () => {
    const result = calculateOrderFinancials({
      gross: 1_000_000, payout: 740_000, commission: 220_000, marketplaceLogistics: 40_000,
      payoutReported: true, commissionReported: true, logisticsReported: true,
      taxPercent: 1, advertisingPercent: 3, fallbackCommissionPercent: 0, ...costs,
    });
    expect(result.payout).toBe(740_000);
    expect(result.profit).toBe(365_000); // 740k - 335k - 10k - 30k
    expect(result.otherMarketplaceDeductions).toBe(0);
  });

  it('shows unknown marketplace deductions separately', () => {
    const result = calculateOrderFinancials({
      gross: 1_000_000, payout: 700_000, commission: 220_000, marketplaceLogistics: 40_000,
      payoutReported: true, commissionReported: true, logisticsReported: true,
      taxPercent: 1, advertisingPercent: 3, fallbackCommissionPercent: 0, ...costs,
    });
    expect(result.otherMarketplaceDeductions).toBe(40_000);
    expect(result.payoutDifference).toBe(-40_000);
  });

  it('honors a reported zero payout instead of falling back', () => {
    const result = calculateOrderFinancials({
      gross: 100_000, payout: 0, commission: 0, marketplaceLogistics: 0,
      payoutReported: true, commissionReported: true, logisticsReported: true,
      taxPercent: 1, advertisingPercent: 3, fallbackCommissionPercent: 25,
      productCost: 0, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0,
    });
    expect(result.payout).toBe(0);
    expect(result.commission).toBe(0);
    expect(result.otherMarketplaceDeductions).toBe(100_000);
  });

  it('uses fallback commission only when API did not report it', () => {
    const result = calculateOrderFinancials({
      gross: 100_000, payout: 0, commission: 0, marketplaceLogistics: 5_000,
      payoutReported: false, commissionReported: false, logisticsReported: true,
      taxPercent: 1, advertisingPercent: 3, fallbackCommissionPercent: 20,
      productCost: 0, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0,
    });
    expect(result.commission).toBe(20_000);
    expect(result.payout).toBe(75_000);
  });
});
