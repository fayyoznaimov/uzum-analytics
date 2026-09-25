import { describe, expect, it } from 'vitest';
import { selectCurrentSkuPayout } from '../sku-payout';

describe('selectCurrentSkuPayout', () => {
  it('uses the latest positive payout sold at the current price', () => {
    const result = selectCurrentSkuPayout(69_200, [
      { issuedAt: new Date('2026-08-02'), itemGross: 59_000, orderGross: 59_000, orderPayout: 40_270, quantity: 1 },
      { issuedAt: new Date('2026-07-29'), itemGross: 69_200, orderGross: 69_200, orderPayout: 48_226, quantity: 1 },
      { issuedAt: new Date('2026-07-20'), itemGross: 69_200, orderGross: 69_200, orderPayout: 47_000, quantity: 1 },
    ], 0);

    expect(result.amount).toBe(48_226);
    expect(result.source).toBe('orders-api-current-price');
    expect(result.sourcePrice).toBe(69_200);
  });

  it('never lets reported zero payouts reduce the displayed payout', () => {
    const result = selectCurrentSkuPayout(69_200, [
      { issuedAt: new Date('2026-08-01'), itemGross: 69_200, orderGross: 69_200, orderPayout: 0, quantity: 1 },
      { issuedAt: new Date('2026-07-29'), itemGross: 69_200, orderGross: 69_200, orderPayout: 48_226, quantity: 1 },
    ], 0);

    expect(result.amount).toBe(48_226);
  });

  it('uses the latest factual unit payout when the current price has no matching sale', () => {
    const result = selectCurrentSkuPayout(70_000, [
      { issuedAt: new Date('2026-08-02'), itemGross: 118_000, orderGross: 118_000, orderPayout: 80_540, quantity: 2 },
    ], 0);

    expect(result.amount).toBe(40_270);
    expect(result.source).toBe('orders-api-latest-price');
    expect(result.sourcePrice).toBe(59_000);
  });

  it('uses the configured fallback only when no positive payout exists', () => {
    const result = selectCurrentSkuPayout(100_000, [], 20);
    expect(result).toMatchObject({ amount: 80_000, source: 'fallback', sourcePrice: null });
  });
});
