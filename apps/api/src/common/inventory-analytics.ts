export type InventoryBaseMetric = {
  endingSoon: boolean;
  coverageIndicator?: string | null;
  coverageDays: number;
  recommendedSupply: number;
  sellerFbsStock: number;
  marketplaceTotal: number;
  inSupply: number;
  availableForSale: number;
  toCustomer: number;
  fromCustomer: number;
  longTermStorage: number;
  photoStudio: number;
  defective: number;
  potentialPayoutUnit: number;
  potentialPayoutTotal: number;
};

export type InventoryCostInput = {
  price: number;
  landedUnitCost: number;
  hasCost: boolean;
  hasPrice: boolean;
  taxPercent: number;
  advertisingPercent: number;
};

export type InventoryCalculated = {
  overstock: boolean;
  targetMarketplaceStock: number;
  targetStockInvestment: number;
  stockCost: number;
  saleValue: number;
  potentialNetProfitKnown: boolean;
  potentialNetProfit: number;
  recommendedPotentialPayout: number;
  recommendedPotentialProfit: number;
  potentialStockRoi: number | null;
  recommendedSupplyRoi: number | null;
  potentialMargin: number | null;
  returnShare: number;
  sellableShare: number;
  blockedUnits: number;
  nonSellableCapital: number;
};

const safe = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function calculateInventoryAnalytics(
  metric: InventoryBaseMetric,
  costs: InventoryCostInput,
): InventoryCalculated {
  const marketplaceTotal = Math.max(0, safe(metric.marketplaceTotal));
  const recommendedSupply = Math.max(0, safe(metric.recommendedSupply));
  const price = Math.max(0, safe(costs.price));
  const landedUnitCost = Math.max(0, safe(costs.landedUnitCost));
  const taxAdvertisingRate = Math.max(0, safe(costs.taxPercent) + safe(costs.advertisingPercent)) / 100;
  const targetMarketplaceStock = marketplaceTotal + recommendedSupply;
  const stockCost = costs.hasCost ? landedUnitCost * marketplaceTotal : 0;
  const targetStockInvestment = costs.hasCost ? landedUnitCost * recommendedSupply : 0;
  const saleValue = costs.hasPrice ? price * marketplaceTotal : 0;
  const recommendedSaleValue = costs.hasPrice ? price * recommendedSupply : 0;
  const potentialNetProfitKnown = costs.hasCost && costs.hasPrice;
  const potentialPayout = safe(metric.potentialPayoutTotal);
  const potentialNetProfit = potentialNetProfitKnown
    ? potentialPayout - stockCost - saleValue * taxAdvertisingRate
    : 0;
  const recommendedPotentialPayout = safe(metric.potentialPayoutUnit) * recommendedSupply;
  const recommendedPotentialProfit = potentialNetProfitKnown
    ? recommendedPotentialPayout - targetStockInvestment - recommendedSaleValue * taxAdvertisingRate
    : 0;
  const blockedUnits = Math.max(0,
    safe(metric.inSupply) + safe(metric.toCustomer) + safe(metric.fromCustomer)
    + safe(metric.longTermStorage) + safe(metric.photoStudio) + safe(metric.defective),
  );
  const nonSellableUnits = Math.max(0,
    safe(metric.fromCustomer) + safe(metric.longTermStorage) + safe(metric.photoStudio) + safe(metric.defective),
  );

  return {
    overstock: String(metric.coverageIndicator || '').toLowerCase().includes('избыток'),
    targetMarketplaceStock,
    targetStockInvestment,
    stockCost,
    saleValue,
    potentialNetProfitKnown,
    potentialNetProfit,
    recommendedPotentialPayout,
    recommendedPotentialProfit,
    potentialStockRoi: potentialNetProfitKnown && stockCost > 0 ? potentialNetProfit / stockCost * 100 : null,
    recommendedSupplyRoi: potentialNetProfitKnown && targetStockInvestment > 0 ? recommendedPotentialProfit / targetStockInvestment * 100 : null,
    potentialMargin: potentialNetProfitKnown && saleValue > 0 ? potentialNetProfit / saleValue * 100 : null,
    returnShare: marketplaceTotal > 0 ? Math.max(0, safe(metric.fromCustomer)) / marketplaceTotal * 100 : 0,
    sellableShare: marketplaceTotal > 0 ? Math.max(0, safe(metric.availableForSale)) / marketplaceTotal * 100 : 0,
    blockedUnits,
    nonSellableCapital: costs.hasCost ? landedUnitCost * nonSellableUnits : 0,
  };
}

export function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
