export type CostBreakdown = {
  productCost: number;
  packagingCost: number;
  warehouseLogisticsCost: number;
  additionalCost: number;
};

export type OrderFinancialInput = CostBreakdown & {
  gross: number;
  payout: number;
  commission: number;
  marketplaceLogistics: number;
  payoutReported?: boolean;
  commissionReported?: boolean;
  logisticsReported?: boolean;
  taxPercent: number;
  advertisingPercent: number;
  fallbackCommissionPercent: number;
};

export type OrderFinancialResult = CostBreakdown & {
  gross: number;
  payout: number;
  payoutCalculated: number;
  payoutDifference: number;
  commission: number;
  commissionPercent: number;
  marketplaceLogistics: number;
  otherMarketplaceDeductions: number;
  marketplaceWithheld: number;
  internalCosts: number;
  tax: number;
  advertising: number;
  profit: number;
  marginPercent: number;
  returnReserve: number;
};

export function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function calculateOrderFinancials(input: OrderFinancialInput): OrderFinancialResult {
  const gross = Math.max(0, finiteNumber(input.gross));
  const marketplaceLogistics = Math.max(0, finiteNumber(input.marketplaceLogistics));

  let commission = Math.max(0, finiteNumber(input.commission));
  const payoutRaw = finiteNumber(input.payout);
  const payoutReported = Boolean(input.payoutReported);
  const commissionReported = Boolean(input.commissionReported);

  if (!commissionReported && commission <= 0 && payoutReported) {
    commission = Math.max(0, gross - Math.max(0, payoutRaw) - marketplaceLogistics);
  }
  if (!commissionReported && commission <= 0 && !payoutReported) {
    commission = gross * Math.max(0, finiteNumber(input.fallbackCommissionPercent)) / 100;
  }

  const payoutCalculated = gross - commission - marketplaceLogistics;
  const payout = payoutReported ? payoutRaw : Math.max(0, payoutCalculated);
  const payoutDifference = payout - payoutCalculated;
  const otherMarketplaceDeductions = Math.max(0, gross - commission - marketplaceLogistics - payout);
  const marketplaceWithheld = gross - payout;

  const productCost = Math.max(0, finiteNumber(input.productCost));
  const packagingCost = Math.max(0, finiteNumber(input.packagingCost));
  const warehouseLogisticsCost = Math.max(0, finiteNumber(input.warehouseLogisticsCost));
  const additionalCost = Math.max(0, finiteNumber(input.additionalCost));
  const internalCosts = productCost + packagingCost + warehouseLogisticsCost + additionalCost;
  const tax = gross * Math.max(0, finiteNumber(input.taxPercent)) / 100;
  const advertising = gross * Math.max(0, finiteNumber(input.advertisingPercent)) / 100;
  const profit = payout - internalCosts - tax - advertising;

  return {
    gross,
    payout,
    payoutCalculated,
    payoutDifference,
    commission,
    commissionPercent: gross > 0 ? commission / gross * 100 : 0,
    marketplaceLogistics,
    otherMarketplaceDeductions,
    marketplaceWithheld,
    productCost,
    packagingCost,
    warehouseLogisticsCost,
    additionalCost,
    internalCosts,
    tax,
    advertising,
    profit,
    marginPercent: gross > 0 ? profit / gross * 100 : 0,
    returnReserve: 0,
  };
}
