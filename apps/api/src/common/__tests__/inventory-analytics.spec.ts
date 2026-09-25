import { describe, expect, it } from 'vitest';
import { calculateInventoryAnalytics, median } from '../inventory-analytics';

const metric = {
  endingSoon: false,
  coverageIndicator: 'Нормально',
  coverageDays: 15,
  recommendedSupply: 10,
  sellerFbsStock: 0,
  marketplaceTotal: 20,
  inSupply: 2,
  availableForSale: 14,
  toCustomer: 2,
  fromCustomer: 1,
  longTermStorage: 0,
  photoStudio: 0,
  defective: 1,
  potentialPayoutUnit: 70_000,
  potentialPayoutTotal: 1_400_000,
};

describe('inventory analytics', () => {
  it('calculates target stock, potential profit and ROI without double subtracting marketplace fees', () => {
    const result = calculateInventoryAnalytics(metric, {
      price: 100_000,
      landedUnitCost: 40_000,
      hasCost: true,
      hasPrice: true,
      taxPercent: 1,
      advertisingPercent: 3,
    });
    expect(result.targetMarketplaceStock).toBe(30);
    expect(result.stockCost).toBe(800_000);
    expect(result.potentialNetProfit).toBe(520_000); // payout 1.4m - cost 0.8m - 4% of 2m
    expect(result.recommendedPotentialProfit).toBe(260_000);
    expect(result.potentialStockRoi).toBe(65);
    expect(result.recommendedSupplyRoi).toBe(65);
    expect(result.sellableShare).toBe(70);
    expect(result.nonSellableCapital).toBe(80_000);
  });

  it('marks profit unknown when price or cost is missing', () => {
    const result = calculateInventoryAnalytics(metric, {
      price: 0,
      landedUnitCost: 40_000,
      hasCost: true,
      hasPrice: false,
      taxPercent: 1,
      advertisingPercent: 3,
    });
    expect(result.potentialNetProfitKnown).toBe(false);
    expect(result.potentialStockRoi).toBeNull();
  });

  it('calculates median coverage', () => {
    expect(median([2, 8, 4, 10])).toBe(6);
    expect(median([])).toBe(0);
  });
});
