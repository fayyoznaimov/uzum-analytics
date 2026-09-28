import { describe, expect, it } from 'vitest';
import { aggregateBuyouts, AutoPricingSkuInput, shiftDay } from '../auto-pricing';
import { formatPromoPlan, niceDown, niceUp, planPromoPrices, planPromoSku, promoFloorPrice, soldPrice } from '../promo-plan';

const today = '2026-09-28';

/** Выкупы: perDay шт. в каждый day-шаг от from до to (смещения от today, включительно). */
function days(from: number, to: number, perDay: number, step = 1) {
  const out: Record<string, number> = {};
  for (let offset = from; offset <= to; offset += step) out[shiftDay(today, offset)] = perDay;
  return out;
}
const revenue = (units: Record<string, number>, price: number) => Object.fromEntries(Object.entries(units).map(([day, n]) => [day, n * price]));

/** Банное: ровные продажи 1 шт. каждые 2 дня по 150 000, базовая 200 000, маржа в норме. */
function sku(patch: Partial<AutoPricingSkuInput> = {}): AutoPricingSkuInput {
  const units = days(-60, -1, 1, 2);
  return {
    skuId: '100',
    productId: '2197711',
    title: 'HAVANA-БЕЖЕВ-70 x140',
    role: 'MARGINAL',
    basePrice: 200_000,
    inOffer: false,
    promos: [],
    stock: 40,
    costAmount: 50_000,
    unitCost: 60_000,
    forecast: { skuId: '100', quantity: 40, avgDailySales: 0.5, turnoverDays: 80, outOfStockDays: null },
    buyouts: units,
    buyoutRevenue: revenue(units, 150_000),
    payoutRatio: 0.75,
    adPercent: 5,
    taxPercent: 1,
    adChange: { changed: false, reason: null },
    history: [],
    minPrice: null,
    ...patch,
  };
}
const plan = (patch: Partial<AutoPricingSkuInput> = {}) => planPromoSku(sku(patch), today);

describe('цены «…900»', () => {
  it('вниз и вверх', () => {
    expect(niceDown(141_234)).toBe(140_900);
    expect(niceDown(141_950)).toBe(141_900);
    expect(niceDown(69_900)).toBe(69_900);
    expect(niceUp(140_901)).toBe(141_900);
    expect(niceUp(69_900)).toBe(69_900);
  });
});

describe('цена продаж и пол по марже', () => {
  it('средняя цена выкупов = выручка / штуки за окно', () => {
    const units = { [shiftDay(today, -2)]: 2, [shiftDay(today, -40)]: 1 };
    const money = { [shiftDay(today, -2)]: 280_000, [shiftDay(today, -40)]: 160_000 };
    expect(soldPrice({ buyouts: units, buyoutRevenue: money }, shiftDay(today, -28), shiftDay(today, -1))).toBe(140_000);
    expect(soldPrice({ buyouts: units, buyoutRevenue: money }, shiftDay(today, -90), shiftDay(today, -1))).toBeCloseTo(146_666.67, 1);
    expect(soldPrice({ buyouts: {}, buyoutRevenue: {} }, shiftDay(today, -28), shiftDay(today, -1))).toBeNull();
  });

  it('пол — цена с маржой ровно 15%; без себестоимости или выплаты — не рассчитан', () => {
    expect(promoFloorPrice({ unitCost: 90_000, payoutRatio: 0.75, adPercent: 5, taxPercent: 1 }, 15)).toBeCloseTo(166_666.67, 1);
    expect(promoFloorPrice({ unitCost: null, payoutRatio: 0.75, adPercent: 5, taxPercent: 1 }, 15)).toBeNull();
    expect(promoFloorPrice({ unitCost: 90_000, payoutRatio: null, adPercent: 5, taxPercent: 1 }, 15)).toBeNull();
  });

  it('выручка выкупов по SKU — за выкупленные штуки, без возвратов', () => {
    const { revenueBySku } = aggregateBuyouts([
      { state: 'PAID', issuedAt: new Date('2026-09-20T10:00:00+05:00'), payout: 45_000, payoutReported: true, gross: 60_000, items: [{ skuId: 'a', productId: 'P', quantity: 3, returns: 1, amount: 90_000 }] },
      { state: 'CANCELED', issuedAt: new Date('2026-09-20T10:00:00+05:00'), payout: 0, payoutReported: false, gross: 30_000, items: [{ skuId: 'a', productId: 'P', quantity: 1, returns: 0, amount: 30_000 }] },
    ]);
    expect(revenueBySku.get('a')).toEqual({ '2026-09-20': 60_000 });
  });
});

describe('план цены SKU в акции', () => {
  it('обычный SKU — цена, по которой продавался последние 28 дней', () => {
    const row = plan();
    expect(row.status).toBe('PRICE');
    expect(row.soldPrice).toBe(150_000);
    expect(row.soldPriceDays).toBe(28);
    expect(row.price).toBe(149_900);
    expect(row.discountPercent).toBe(25);
    expect(row.marginPercent).toBeCloseTo(28.97, 1);
    expect(row.reason).toContain('продавался последние 28');
  });

  it('мало остатка — минимальная скидка от базовой', () => {
    const row = plan({ stock: 2 });
    expect(row.price).toBe(197_900);
    expect(row.reason).toContain('мало остатка (2 шт.');
    expect(plan({ forecast: { skuId: '100', quantity: 10, avgDailySales: 2, turnoverDays: 5, outOfStockDays: null } }).price).toBe(197_900);
  });

  it('почти нет продаж — на 7% ниже прошлой цены продаж (90 дней), без продаж — базовая −20%', () => {
    const old = { [shiftDay(today, -40)]: 1 };
    const row = plan({ buyouts: old, buyoutRevenue: revenue(old, 160_000) });
    expect(row.soldPriceDays).toBe(90);
    expect(row.price).toBe(147_900);
    expect(row.reason).toContain('почти нет продаж (0 шт. за 28 дн.)');
    const none = plan({ buyouts: {}, buyoutRevenue: {} });
    expect(none.price).toBe(159_900);
    expect(none.reason).toContain('нет продаж за 90 дн.');
  });

  it('хорошо продаётся — цена продаж +3%, лицевые не поднимаем', () => {
    const week = days(-7, -1, 1);
    expect(plan({ buyouts: week, buyoutRevenue: revenue(week, 150_000) }).price).toBe(153_900);
    const face = plan({ role: 'LOCOMOTIVE', buyouts: week, buyoutRevenue: revenue(week, 150_000) });
    expect(face.price).toBe(149_900);
    expect(face.reason).toContain('лицевое — не поднимаем');
  });

  it('не выше базовой −1%: базовую опустили ниже прошлой цены продаж', () => {
    const row = plan({ basePrice: 140_000 });
    expect(row.price).toBe(137_900);
    expect(row.reason).toContain('не выше базовой');
  });

  it('ниже маржи 15% не опускаем, а если и при 1% маржи нет — не добавлять', () => {
    const raised = plan({ unitCost: 90_000 });
    expect(raised.price).toBe(166_900);
    expect(raised.marginPercent).toBeGreaterThanOrEqual(15);
    expect(raised.reason).toContain('поднято до маржи 15%');
    const loss = plan({ unitCost: 110_000 });
    expect(loss.status).toBe('SKIP');
    expect(loss.reason).toContain('маржа ниже 15%');
  });

  it('без себестоимости цена предлагается, но маржа «не рассчитана» — это видно', () => {
    const row = plan({ unitCost: null });
    expect(row.price).toBe(149_900);
    expect(row.marginPercent).toBeNull();
    expect(row.reason).toContain('себестоимость не задана');
  });

  it('пропуски: нет остатка, SKU не используется, недоступен в Uzum, нет базовой цены', () => {
    expect(plan({ stock: 0 }).reason).toBe('нет остатка');
    expect(plan({ costAmount: 3 }).reason).toContain('не используется');
    expect(plan({ unavailable: 'в архиве Uzum' }).reason).toBe('в архиве Uzum');
    expect(plan({ basePrice: null }).reason).toBe('нет базовой цены');
  });
});

describe('текст плана', () => {
  it('по товарам, с разделом «Не добавлять» и итогом', () => {
    const rows = planPromoPrices([sku(), sku({ skuId: '200', title: 'HAVANA-БЕЛЫЙ-70 x140', stock: 0 }), sku({ skuId: '300', productId: '2263224', title: 'HAVANASAUNA-БЕЖЕВ' })], today);
    const text = formatPromoPlan(rows, new Map([['2197711', 'Полотенце пышное']])).join('\n');
    expect(text).toContain('=== Товар 2197711 — Полотенце пышное ===');
    expect(text).toContain('=== Товар 2263224 ===');
    expect(text).toMatch(/100 \| HAVANA-БЕЖЕВ-70 x140 \| 40 \| 3\/14 \| 150\s000 \(28 дн\.\) \| 200\s000 \| 60\s000 \| 149\s900 \| 25% \| 29% \|/);
    expect(text).toContain('=== Не добавлять в акцию ===\n200 | HAVANA-БЕЛЫЙ-70 x140 | нет остатка');
    expect(text).toContain('Итого: цена предложена для 2 SKU, не добавлять 1.');
  });
});
