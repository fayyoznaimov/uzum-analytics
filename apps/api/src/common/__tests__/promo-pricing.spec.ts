import { describe, expect, it } from 'vitest';
import {
  isLastPromoPage,
  parsePromoProducts,
  parsePromoSale,
  parsePromoSales,
  planPromoPriceChange,
  PROMO_TOKEN_EXPIRED_MESSAGE,
  promoApiErrorMessage,
  PromoPriceChangeInput,
} from '../promo-pricing';

// Формы ответов сняты со страницы «Участие в акции» 25.09.2026 (акция 393).
const productsBody = {
  payload: {
    content: [{
      productId: 2880108,
      title: { uz: 'Parisa Home paxtali pled', ru: 'Хлопковый плед Parisa Home' },
      skuList: [
        { skuId: 10549127, skuTitle: 'FAYYOZ-YD-beach', availableCount: 19, currentSellPrice: 230000, salePrice: 170000, maxSuitablePrice: 227700 },
        { skuId: 10616545, skuTitle: 'FAYYOZ-YD-hand', availableCount: 0, currentSellPrice: 30000, salePrice: 29700, maxSuitablePrice: 29700 },
      ],
    }, {
      productId: 2263224,
      skuList: [{ skuId: 8108058, skuTitle: 'FAYYOZ-HAVANASAUNA-3', availableCount: 5, currentSellPrice: 199000, salePrice: 169000, maxSuitablePrice: 197010 }],
    }],
  },
};
const saleBody = {
  payload: {
    id: 393, title: '21.09-29.09 Скидки недели 3/Hafta chegirmalari 3', startDate: '2026-09-21', finishDate: '2026-09-29',
    status: 'ACTIVE', type: 'BIG_SALE', involvedProductsCount: 5, priceRule: { minPrice: 1000, maxPrice: 50000000 },
  },
};

const saleSkus = parsePromoProducts(393, productsBody);
const base: PromoPriceChangeInput = {
  shopExternalId: '92776',
  sale: parsePromoSale(saleBody),
  skuId: 10616545,
  saleSkus,
  newPrice: 29_600,
  minPrice: 20_000,
};
const codes = (input: Partial<PromoPriceChangeInput>) => planPromoPriceChange({ ...base, ...input }).violations.map((v) => v.code);

describe('promo responses', () => {
  it('flattens sale products into SKUs with base price, promo price and limit', () => {
    expect(saleSkus).toHaveLength(3);
    expect(saleSkus[1]).toEqual({ saleId: 393, productId: 2880108, skuId: 10616545, skuTitle: 'FAYYOZ-YD-hand', availableCount: 0, basePrice: 30000, salePrice: 29700, maxPrice: 29700 });
  });

  it('parses the sale list and the sale card with its price rule', () => {
    const sales = parsePromoSales({ payload: [{ id: 394, title: 'Скидки к празднику', status: 'CREATED', involvedProductsCount: 0 }, saleBody.payload] });
    expect(sales.map((sale) => [sale.id, sale.status])).toEqual([[394, 'CREATED'], [393, 'ACTIVE']]);
    expect(base.sale.priceRule).toEqual({ minPrice: 1000, maxPrice: 50000000 });
  });

  it('throws on unrecognized shapes instead of returning an empty list', () => {
    expect(() => parsePromoSales({ payload: { content: [] } })).toThrow();
    expect(() => parsePromoProducts(393, { payload: [] })).toThrow();
    expect(() => parsePromoSale({})).toThrow();
  });

  it('detects the last page', () => {
    expect(isLastPromoPage(productsBody, 24)).toBe(true);
    expect(isLastPromoPage({ payload: { content: new Array(24).fill({}) } }, 24)).toBe(false);
    expect(isLastPromoPage({ payload: { content: new Array(24).fill({}), last: true } }, 24)).toBe(true);
    expect(isLastPromoPage({ payload: { content: new Array(24).fill({}), number: 0, totalPages: 2 } }, 24)).toBe(false);
  });
});

describe('planPromoPriceChange', () => {
  it('sends the whole product with siblings at their current promo prices, like the cabinet', () => {
    const plan = planPromoPriceChange(base);
    expect(plan.allowed).toBe(true);
    expect(plan.path).toBe('/shop/92776/marketing/sales/393/products');
    expect(plan.body).toEqual({ products: [{ productId: 2880108, skuList: [{ skuId: 10549127, newSalePrice: 170000 }, { skuId: 10616545, newSalePrice: 29600 }] }] });
  });

  it('refuses above the promo limit, but allows exactly the limit', () => {
    const cheaper = saleSkus.map((row) => (row.skuId === 10616545 ? { ...row, salePrice: 29_000 } : row));
    expect(codes({ saleSkus: cheaper, newPrice: 29_700 })).toEqual([]);
    expect(codes({ saleSkus: cheaper, newPrice: 29_701 })).toContain('ABOVE_PROMO_LIMIT');
    expect(codes({ saleSkus: saleSkus.map((row) => ({ ...row, maxPrice: null })) })).toContain('ABOVE_PROMO_LIMIT');
  });

  it('applies the shared guards: step, floor, unit cost, no change', () => {
    expect(codes({ newPrice: 28_215 })).toEqual([]);
    expect(codes({ newPrice: 28_214 })).toContain('STEP_TOO_LARGE');
    expect(codes({ minPrice: null })).toEqual(['NO_FLOOR']);
    expect(codes({ minPrice: 29_650 })).toContain('BELOW_MIN_PRICE');
    expect(codes({ unitCost: 29_650 })).toContain('BELOW_UNIT_COST');
    expect(codes({ newPrice: 29_700 })).toContain('NO_CHANGE');
  });

  it('refuses SKUs outside the sale, finished sales and prices outside the sale rule', () => {
    const plan = planPromoPriceChange({ ...base, skuId: 1 });
    expect(plan.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['NOT_IN_SALE', 'CURRENT_PRICE_UNKNOWN']));
    expect(plan.body).toEqual({ products: [] });
    expect(codes({ sale: { ...base.sale, status: 'COMPLETED' } })).toContain('SALE_NOT_EDITABLE');
    expect(codes({ sale: { ...base.sale, status: 'CREATED' } })).toEqual([]);
    expect(codes({ sale: { ...base.sale, priceRule: { minPrice: 29_650, maxPrice: null } } })).toContain('OUTSIDE_SALE_PRICE_RULE');
  });

  it('refuses when a sibling SKU of the same product has no known promo price', () => {
    const broken = saleSkus.map((row) => (row.skuId === 10549127 ? { ...row, salePrice: null } : row));
    expect(codes({ saleSkus: broken })).toContain('CURRENT_PRICE_UNKNOWN');
  });
});

describe('promoApiErrorMessage', () => {
  it('turns 401 into a clear "refresh the cabinet token" message', () => {
    expect(promoApiErrorMessage('/x', 401, {})).toBe(PROMO_TOKEN_EXPIRED_MESSAGE);
    expect(PROMO_TOKEN_EXPIRED_MESSAGE).toContain('Настройки → Отзывы Uzum');
    expect(promoApiErrorMessage('/x', 400, { errors: [{ code: 'sale-001', message: 'Цена выше допустимой' }] })).toBe('/x: HTTP 400 — Цена выше допустимой');
  });
});
