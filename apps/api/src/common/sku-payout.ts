export type SkuPayoutObservation = {
  issuedAt: Date;
  itemGross: number;
  orderGross: number;
  orderPayout: number;
  quantity: number;
};

export type CurrentSkuPayout = {
  amount: number;
  source: 'orders-api-current-price' | 'orders-api-latest-price' | 'fallback';
  sourcePrice: number | null;
  sourceIssuedAt: Date | null;
};

const moneyMatches = (left: number, right: number) => Math.abs(left - right) < 0.01;

export function selectCurrentSkuPayout(
  currentPrice: number,
  observations: SkuPayoutObservation[],
  fallbackCommissionPercent: number,
): CurrentSkuPayout {
  const valid = observations
    .filter((row) => row.quantity > 0 && row.itemGross > 0 && row.orderGross > 0 && row.orderPayout > 0 && row.orderPayout <= row.orderGross)
    .map((row) => {
      const sourcePrice = row.itemGross / row.quantity;
      const allocatedPayout = row.orderPayout * Math.min(1, row.itemGross / row.orderGross);
      return { ...row, sourcePrice, amount: allocatedPayout / row.quantity };
    })
    .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());

  const selected = valid.find((row) => moneyMatches(row.sourcePrice, currentPrice)) ?? valid[0];
  if (selected) {
    return {
      amount: selected.amount,
      source: moneyMatches(selected.sourcePrice, currentPrice) ? 'orders-api-current-price' : 'orders-api-latest-price',
      sourcePrice: selected.sourcePrice,
      sourceIssuedAt: selected.issuedAt,
    };
  }

  return {
    amount: currentPrice * (1 - fallbackCommissionPercent / 100),
    source: 'fallback',
    sourcePrice: null,
    sourceIssuedAt: null,
  };
}
