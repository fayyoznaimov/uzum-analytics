import { describe, expect, it } from 'vitest';
import { planPriceChange, PriceChangeInput } from '../pricing';

const base: PriceChangeInput = {
  shopExternalId: '92776',
  productExternalId: '2898275',
  skuExternalId: '11100529',
  currentPrice: 59_400,
  newPrice: 58_900,
  minPrice: 50_000,
};

const codes = (input: Partial<PriceChangeInput>) => planPriceChange({ ...base, ...input }).violations.map((v) => v.code);

describe('planPriceChange', () => {
  it('builds the sendPriceData body with sellPrice only', () => {
    const plan = planPriceChange(base);
    expect(plan.allowed).toBe(true);
    expect(plan.path).toBe('/v1/product/92776/sendPriceData');
    expect(plan.body).toEqual({ productId: 2898275, skuList: [{ skuId: 11100529, sellPrice: 58_900 }] });
  });

  it('sends fullPrice only when given and not below the sell price', () => {
    expect(planPriceChange({ ...base, fullPrice: 65_000 }).body.skuList[0]).toEqual({ skuId: 11100529, sellPrice: 58_900, fullPrice: 65_000 });
    expect(codes({ fullPrice: 50_000 })).toContain('INVALID_FULL_PRICE');
  });

  it('sends skuTitle only when given', () => {
    expect(planPriceChange({ ...base, skuTitle: 'СИРЕН-лицево' }).body.skuList[0]).toEqual({ skuId: 11100529, sellPrice: 58_900, skuTitle: 'СИРЕН-лицево' });
  });

  it('limits the step to ±5% by default, inclusive', () => {
    expect(codes({ newPrice: 62_370 })).toEqual([]);
    expect(codes({ newPrice: 62_371 })).toContain('STEP_TOO_LARGE');
    expect(codes({ newPrice: 56_430 })).toEqual([]);
    expect(codes({ newPrice: 56_429 })).toContain('STEP_TOO_LARGE');
    expect(codes({ newPrice: 62_371, maxStepPercent: 10 })).toEqual([]);
  });

  it('refuses without a floor, below the floor and below unit cost', () => {
    expect(codes({ minPrice: null })).toEqual(['NO_FLOOR']);
    expect(codes({ minPrice: null, unitCost: 40_000 })).toEqual([]);
    expect(codes({ minPrice: 59_000 })).toContain('BELOW_MIN_PRICE');
    expect(codes({ unitCost: 59_000 })).toContain('BELOW_UNIT_COST');
    expect(planPriceChange({ ...base, unitCost: 55_000 }).floor).toBe(55_000);
  });

  it('refuses when the current price is unknown or unchanged', () => {
    expect(codes({ currentPrice: null })).toContain('CURRENT_PRICE_UNKNOWN');
    expect(codes({ newPrice: 59_400 })).toContain('NO_CHANGE');
  });

  it('refuses non-integer and out-of-range prices', () => {
    expect(codes({ newPrice: 58_900.5 })).toContain('INVALID_PRICE');
    expect(codes({ newPrice: 0, minPrice: null, unitCost: null })).toContain('INVALID_PRICE');
  });

  it('refuses blocked, archived and promo SKUs unless promo is explicitly allowed', () => {
    expect(codes({ blocked: true })).toContain('SKU_BLOCKED');
    expect(codes({ archived: true })).toContain('SKU_ARCHIVED');
    expect(codes({ inPromo: true })).toContain('IN_PROMO');
    expect(codes({ inPromo: true, allowDuringPromo: true })).toEqual([]);
  });
});
