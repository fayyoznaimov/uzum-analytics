import { describe, expect, it } from 'vitest';
import {
  adjustPrice,
  adSharePercent,
  advertisingChanged,
  aggregateBuyouts,
  AUTO_PRICING_DEFAULTS,
  AutoDecision,
  AutoPriceEvent,
  AutoPricingSkuInput,
  daysOfStock,
  evaluateSku,
  formatAutoPricingReport,
  isUnusedCost,
  marginPercent,
  outOfStockDays,
  parseCabinetProducts,
  payoutRatio,
  planAutoPricingRun,
  shiftDay,
  skuRole,
  StockForecast,
  sumDays,
} from '../auto-pricing';

const today = '2026-09-26';
const now = new Date('2026-09-26T09:30:00+05:00');
const at = (day: string, time = '10:00:00') => new Date(`${day}T${time}+05:00`);

/** Выкупы: perDay шт. в каждый день from…to (смещения от today, включительно). */
function buyouts(from: number, to: number, perDay: number, into: Record<string, number> = {}) {
  for (let offset = from; offset <= to; offset++) into[shiftDay(today, offset)] = (into[shiftDay(today, offset)] ?? 0) + perDay;
  return into;
}
const forecast = (patch: Partial<StockForecast> = {}): StockForecast => ({ skuId: '100', quantity: 50, avgDailySales: 1, turnoverDays: 30, outOfStockDays: null, ...patch });

/** Маржинальный SKU с нормальным запасом и ровными продажами 1 шт. каждые 2 дня — правила не срабатывают. */
function sku(patch: Partial<AutoPricingSkuInput> = {}): AutoPricingSkuInput {
  const steady: Record<string, number> = {};
  for (let offset = -60; offset <= -1; offset += 2) steady[shiftDay(today, offset)] = 1;
  return {
    skuId: '100',
    productId: '2880108',
    title: 'FAYYOZ-J471-РОЗОВ-БАННЫЙ',
    role: 'MARGINAL',
    basePrice: 30_000,
    inOffer: false,
    promos: [],
    stock: 50,
    costAmount: 9_000,
    unitCost: 10_000,
    forecast: forecast(),
    buyouts: steady,
    payoutRatio: 0.75,
    adPercent: 5,
    taxPercent: 1,
    adChange: { changed: false, reason: null },
    history: [],
    minPrice: null,
    ...patch,
  };
}
const event = (patch: Partial<AutoPriceEvent>): AutoPriceEvent => ({ at: at('2026-09-20'), kind: 'BASE', oldPrice: 30_000, newPrice: 30_600, rule: 'FLOW', stock: 50, ...patch });
const evaluate = (patch: Partial<AutoPricingSkuInput> = {}) => evaluateSku(sku(patch), today);

describe('роли и пометки', () => {
  it('лицевые (в т.ч. HAVANA 50×90) — локомотивы, остальные — маржинальные', () => {
    expect(skuRole('FAYYOZ-HAVANA-СЕРЫЙ-50X90')).toBe('LOCOMOTIVE');
    expect(skuRole('HAVANA-БЕЖЕВ-50×90')).toBe('LOCOMOTIVE');
    expect(skuRole('FAYYOZ-J471-РОЗОВ-ЛИЦЕВОЙ')).toBe('LOCOMOTIVE');
    expect(skuRole('FAYYOZ-HAVANA-СЕРЫЙ-70X140')).toBe('MARGINAL');
    expect(skuRole('HAVANA-СЕРЫЙ-50X90/70X140')).toBe('MARGINAL');
    expect(skuRole('FAYYOZ-YD-beach')).toBe('MARGINAL');
    expect(skuRole('FAYYOZ-YD-beach', '10549127', ['10549127'])).toBe('LOCOMOTIVE');
  });

  it('себестоимость 2–5 сум — «не используется»', () => {
    expect([1, 2, 3.5, 5, 6, null].map((value) => isUnusedCost(value))).toEqual([false, true, true, true, false, false]);
  });
});

describe('запас из кабинета (getProducts)', () => {
  it('разбирает skuList[] с avgdsales, turnover, forecastOutOfStock', () => {
    const body = { payload: { productList: [{ productId: 1, skuList: [
      { skuId: 10616545, quantityActive: 12, avgdsales: 2, turnover: 6, forecastOutOfStock: '2026-10-01T00:00:00+05:00' },
      { skuId: 10549127, quantityActive: 0, avgdsales: 0, turnover: null, forecastOutOfStock: null },
    ] }] } };
    const rows = parseCabinetProducts(body, now);
    expect(rows.map((row) => row.skuId)).toEqual(['10616545', '10549127']);
    expect(rows[0]).toMatchObject({ quantity: 12, avgDailySales: 2, turnoverDays: 6 });
    expect(rows[0].outOfStockDays).toBeCloseTo(4.6, 1);
    expect(rows[1]).toMatchObject({ quantity: 0, avgDailySales: 0, turnoverDays: null, outOfStockDays: null });
    expect(parseCabinetProducts({ productList: [{ skuList: [{ skuId: 1 }] }] }, now)).toHaveLength(1);
    expect(() => parseCabinetProducts({ payload: { total: 3 } }, now)).toThrow('getProducts');
  });

  it('forecastOutOfStock: дата строкой, в мс, в секундах или число дней', () => {
    const inFiveDays = now.getTime() + 5 * 86_400_000;
    expect(outOfStockDays(new Date(inFiveDays).toISOString(), now)).toBeCloseTo(5);
    expect(outOfStockDays(inFiveDays, now)).toBeCloseTo(5);
    expect(outOfStockDays(Math.round(inFiveDays / 1000), now)).toBeCloseTo(5, 3);
    expect(outOfStockDays(4, now)).toBe(4);
    expect(outOfStockDays('2026-09-01', now)).toBe(0);
    expect(outOfStockDays(true, now)).toBeNull();
    expect(outOfStockDays('скоро', now)).toBeNull();
  });

  it('дни запаса: прогноз → оборачиваемость → остаток / продажи в день', () => {
    expect(daysOfStock(forecast({ outOfStockDays: 2, turnoverDays: 9 }), 5)).toEqual({ days: 2, source: 'прогноз окончания' });
    expect(daysOfStock(forecast({ turnoverDays: 9 }), 5)).toEqual({ days: 9, source: 'оборачиваемость' });
    expect(daysOfStock(forecast({ turnoverDays: null, quantity: 12, avgDailySales: 3 }), 5)).toEqual({ days: 4, source: 'остаток / продажи в день' });
    expect(daysOfStock(forecast({ turnoverDays: null, avgDailySales: 0 }), 5)).toEqual({ days: null, source: null });
    expect(daysOfStock(null, 5)).toEqual({ days: null, source: null });
  });
});

describe('выкупы, а не заказы', () => {
  const item = (patch = {}) => ({ skuId: 'a', productId: 'P1', quantity: 1, returns: 0, amount: 30_000, ...patch });

  it('считает только PAID по дате выдачи и без возвратов', () => {
    const { bySku } = aggregateBuyouts([
      { state: 'PAID', issuedAt: at('2026-09-20', '23:30:00'), payout: 45_000, payoutReported: true, gross: 60_000, items: [item({ quantity: 3, returns: 1, amount: 90_000 })] },
      { state: 'WAITING', issuedAt: at('2026-09-20'), payout: 0, payoutReported: false, gross: 30_000, items: [item()] },
      { state: 'CANCELED', issuedAt: at('2026-09-20'), payout: 0, payoutReported: false, gross: 30_000, items: [item()] },
      { state: 'RETURNED', issuedAt: at('2026-09-21'), payout: 0, payoutReported: false, gross: 0, items: [item()] },
      { state: 'PAID', issuedAt: at('2026-09-21', '00:30:00'), payout: 22_000, payoutReported: true, gross: 30_000, items: [item()] },
    ]);
    expect(bySku.get('a')).toEqual({ '2026-09-20': 2, '2026-09-21': 1 });
  });

  it('выплата и реклама — по деньгам выкупов, делятся между товарами заказа по сумме позиций', () => {
    const { products, shop } = aggregateBuyouts([
      { state: 'PAID', issuedAt: at('2026-09-20'), payout: 75_000, payoutReported: true, gross: 100_000, items: [item({ amount: 60_000 }), item({ skuId: 'b', productId: 'P2', amount: 40_000 })] },
      { state: 'PAID', issuedAt: at('2026-09-21'), payout: 0, payoutReported: false, gross: 50_000, items: [item({ amount: 50_000 })] },
    ]);
    expect(products.get('P1')).toEqual({ gross: 110_000, payout: 45_000, payoutGross: 60_000 });
    expect(payoutRatio(products.get('P1'))).toBeCloseTo(0.75);
    expect(payoutRatio(shop)).toBeCloseTo(0.75);
    expect(payoutRatio(undefined)).toBeNull();
    expect(adSharePercent(5_500, products.get('P1'))).toBeCloseTo(5);
    expect(adSharePercent(0, undefined)).toBe(0);
    expect(adSharePercent(1_000, undefined)).toBeNull();
  });
});

describe('реклама за неделю', () => {
  it('ставка менялась внутри недели или относительно прошлой', () => {
    const rates = [{ percent: 10, observedAt: at('2026-09-10') }, { percent: 12, observedAt: at('2026-09-22') }];
    expect(advertisingChanged({ rates, topSpendByDay: {} }, today)).toMatchObject({ changed: true, reason: 'ставка рекламы менялась: 10% → 12%' });
    expect(advertisingChanged({ rates: [{ percent: 10, observedAt: at('2026-09-10') }, { percent: 10, observedAt: at('2026-09-22') }], topSpendByDay: {} }, today).changed).toBe(false);
  });

  it('бюджет продвижения: включили, выключили или расход изменился больше чем в 1,3 раза', () => {
    expect(advertisingChanged({ rates: [], topSpendByDay: buyouts(-7, -1, 10_000) }, today).changed).toBe(true);
    expect(advertisingChanged({ rates: [], topSpendByDay: buyouts(-14, -8, 10_000) }, today).changed).toBe(true);
    expect(advertisingChanged({ rates: [], topSpendByDay: buyouts(-14, -1, 10_000) }, today).changed).toBe(false);
    expect(advertisingChanged({ rates: [], topSpendByDay: buyouts(-7, -1, 5_000, buyouts(-14, -1, 10_000)) }, today).changed).toBe(true);
  });
});

describe('цена и маржа', () => {
  it('округляет до 100 сум в сторону изменения, не выходя за шаг', () => {
    expect(adjustPrice(29_700, 3)).toBe(30_600);
    expect(adjustPrice(29_700, -2)).toBe(29_100);
    expect(adjustPrice(30_000, 2)).toBe(30_600);
    expect(adjustPrice(1_000, 3)).toBe(1_030);
  });

  it('маржа не считается, если чего-то не знаем', () => {
    expect(marginPercent(30_000, { unitCost: 10_000, payoutRatio: 0.75, adPercent: 5, taxPercent: 1 })).toBeCloseTo(35.67, 2);
    expect(marginPercent(30_000, { unitCost: 10_000, payoutRatio: null, adPercent: 5, taxPercent: 1 })).toBeNull();
    expect(marginPercent(30_000, { unitCost: 10_000, payoutRatio: 0.75, adPercent: null, taxPercent: 1 })).toBeNull();
  });

  it('окна продаж — полные дни до вчера', () => {
    const byDay = buyouts(-7, 0, 1);
    expect(sumDays(byDay, shiftDay(today, -7), shiftDay(today, -1))).toBe(7);
    expect(evaluateSku(sku({ buyouts: byDay }), today).metrics.units7).toBe(7);
  });
});

describe('evaluateSku: пропуски', () => {
  it('не используется, нулевой остаток, нет себестоимости, уже меняли сегодня', () => {
    expect(evaluate({ unavailable: 'в архиве Uzum' })).toMatchObject({ status: 'SKIP', reason: 'в архиве Uzum' });
    expect(evaluate({ costAmount: 3 })).toMatchObject({ status: 'SKIP', reason: 'не используется (себестоимость 2–5 сум)' });
    expect(evaluate({ stock: 0 })).toMatchObject({ status: 'SKIP', reason: 'нулевой остаток' });
    expect(evaluate({ unitCost: null })).toMatchObject({ status: 'SKIP', reason: 'нет себестоимости' });
    expect(evaluate({ history: [event({ at: at(today, '08:00:00'), rule: null })] })).toMatchObject({ status: 'SKIP', reason: 'цена уже менялась сегодня' });
  });

  it('ровные продажи и нормальный запас — ничего не делаем', () => {
    expect(evaluate()).toMatchObject({ status: 'HOLD', reason: 'правила не сработали' });
  });
});

describe('evaluateSku: локомотивы', () => {
  const loco = (patch: Partial<AutoPricingSkuInput> = {}) => evaluate({ role: 'LOCOMOTIVE', title: 'FAYYOZ-HAVANA-СЕРЫЙ-50X90', ...patch });

  it('за поток цену не поднимаем', () => {
    expect(loco({ buyouts: buyouts(-7, -1, 3) })).toMatchObject({ status: 'HOLD', reason: 'локомотив: за поток цену не поднимаем' });
  });

  it('запас < 3 дней → +3%', () => {
    expect(loco({ forecast: forecast({ turnoverDays: 2 }) })).toMatchObject({ status: 'CHANGE', rule: 'LOCO_DEFICIT', kind: 'BASE', currentPrice: 30_000, newPrice: 30_900 });
    expect(loco({ forecast: forecast({ turnoverDays: 5 }) }).status).toBe('HOLD');
  });

  it('после поставки возвращаем прежнюю цену, до неё — ждём', () => {
    const raised = event({ rule: 'LOCO_DEFICIT', oldPrice: 30_000, newPrice: 30_900, stock: 4 });
    expect(loco({ basePrice: 30_900, stock: 5, forecast: forecast({ turnoverDays: 2 }), history: [raised] }))
      .toMatchObject({ status: 'HOLD', reason: 'цена поднята из-за дефицита — ждём поставку' });
    expect(loco({ basePrice: 30_900, stock: 40, forecast: forecast({ turnoverDays: 2 }), history: [raised] }))
      .toMatchObject({ status: 'CHANGE', rule: 'LOCO_RESTORE', newPrice: 30_000 });
    expect(loco({ basePrice: 30_900, stock: 6, forecast: forecast({ turnoverDays: 8 }), history: [raised] }))
      .toMatchObject({ status: 'CHANGE', rule: 'LOCO_RESTORE', newPrice: 30_000 });
  });

  it('без данных кабинета о запасе — не трогаем', () => {
    expect(loco({ forecast: null })).toMatchObject({ status: 'HOLD', reason: 'нет данных о запасе из кабинета' });
  });
});

describe('evaluateSku: маржинальные', () => {
  const flowing = () => buyouts(-7, -1, 1, buyouts(-28, -8, 0.15));

  it('дефицит < 7 дней → +3%', () => {
    expect(evaluate({ forecast: forecast({ turnoverDays: 6 }) })).toMatchObject({ status: 'CHANGE', rule: 'DEFICIT', newPrice: 30_900, deltaPercent: 3 });
  });

  it('поток ≥ 1,2× и ≥ 3 шт./нед → +2%', () => {
    const decision = evaluate({ buyouts: flowing() });
    expect(decision).toMatchObject({ status: 'CHANGE', rule: 'FLOW', newPrice: 30_600, deltaPercent: 2 });
    expect(decision.metrics.units7).toBe(7);
  });

  it('поток меньше 3 шт. в неделю — не поднимаем', () => {
    expect(evaluate({ buyouts: buyouts(-7, -6, 1) }).rule).not.toBe('FLOW');
  });

  it('поток не считаем, если на неделе менялась реклама', () => {
    const decision = evaluate({ buyouts: flowing(), adChange: { changed: true, reason: 'ставка рекламы менялась: 10% → 12%' } });
    expect(decision.status).toBe('HOLD');
    expect(decision.reason).toContain('менялась реклама');
  });

  it('после повышения за поток выкупы −35% за 3 дня → возврат цены и 14 дней без повышений', () => {
    const byDay = buyouts(-33, -6, 1); // до повышения 21.09 — 1 шт./день
    byDay['2026-09-22'] = 0; byDay['2026-09-23'] = 1; byDay['2026-09-24'] = 0; byDay['2026-09-25'] = 0;
    const raised = event({ at: at('2026-09-21'), rule: 'FLOW', oldPrice: 30_000, newPrice: 30_600 });
    expect(evaluate({ basePrice: 30_600, buyouts: byDay, history: [raised] })).toMatchObject({ status: 'CHANGE', rule: 'FLOW_REVERT', newPrice: 30_000 });

    const reverted = event({ at: at('2026-09-25'), rule: 'FLOW_REVERT', oldPrice: 30_600, newPrice: 30_000 });
    const banned = evaluate({ buyouts: flowing(), history: [reverted, raised] });
    expect(banned.status).toBe('HOLD');
    expect(banned.reason).toContain('14 дн. не поднимаем');
    expect(evaluate({ forecast: forecast({ turnoverDays: 3 }), history: [reverted, raised] }).status).toBe('HOLD');
  });

  it('продажи после повышения не упали — цену не возвращаем', () => {
    const byDay = buyouts(-33, -1, 1);
    const raised = event({ at: at('2026-09-21'), rule: 'FLOW' });
    expect(evaluate({ basePrice: 30_600, buyouts: byDay, history: [raised] }).rule).not.toBe('FLOW_REVERT');
  });

  it('возврат не делаем, если цену уже поменяли вручную', () => {
    const byDay = buyouts(-33, -6, 1);
    const raised = event({ at: at('2026-09-21'), rule: 'FLOW' });
    expect(evaluate({ basePrice: 31_000, buyouts: byDay, history: [raised] })).toMatchObject({ status: 'HOLD', rule: 'FLOW_REVERT' });
  });

  it('≤ 1 выкупа за 28 дней → −2%, если маржа после снижения не ниже минимума', () => {
    const slow = buyouts(-10, -10, 1);
    const decision = evaluate({ buyouts: slow });
    expect(decision).toMatchObject({ status: 'CHANGE', rule: 'SLOW', newPrice: 29_400, deltaPercent: -2 });
    expect(decision.metrics.marginAfterPercent).toBeCloseTo(34.99, 1);
    expect(evaluate({ buyouts: slow, unitCost: 18_000 }).reason).toContain('маржа после снижения');
    expect(evaluate({ buyouts: slow, payoutRatio: null }).reason).toContain('маржа не рассчитана');
    expect(evaluate({ buyouts: slow, history: [event({ at: at('2026-09-22'), rule: 'SLOW', oldPrice: 30_600, newPrice: 30_000 })] }).status).toBe('HOLD');
  });

  it('не опускаем ниже минимальной цены', () => {
    expect(evaluate({ buyouts: {}, minPrice: 29_900 })).toMatchObject({ status: 'HOLD', rule: 'SLOW' });
  });
});

describe('evaluateSku: акции', () => {
  const promo = (patch = {}) => ({ saleId: 393, saleTitle: 'Скидки недели 3', status: 'ACTIVE', salePrice: 29_700, maxPrice: 29_700, basePrice: 30_000, ...patch });

  it('цена в акции на лимите «не более» — рекомендация поднять базовую после акции', () => {
    const decision = evaluate({ basePrice: 29_700, inOffer: true, promos: [promo()], forecast: forecast({ turnoverDays: 5 }) });
    expect(decision).toMatchObject({ status: 'RECOMMEND', rule: 'DEFICIT', kind: 'PROMO', saleId: 393, currentPrice: 29_700 });
    expect(decision.reason).toContain('поднять базовую после акции');
  });

  it('повышение в акции ограничено лимитом «не более»', () => {
    const decision = evaluate({ inOffer: true, promos: [promo({ maxPrice: 30_200 })], forecast: forecast({ turnoverDays: 5 }) });
    expect(decision).toMatchObject({ status: 'CHANGE', kind: 'PROMO', saleId: 393, currentPrice: 29_700, newPrice: 30_200 });
    expect(decision.reason).toContain('ограничено лимитом');
  });

  it('снижение в акции — меняем цену акции', () => {
    expect(evaluate({ inOffer: true, promos: [promo()], buyouts: {} })).toMatchObject({ status: 'CHANGE', rule: 'SLOW', kind: 'PROMO', newPrice: 29_100 });
  });

  it('запланированная акция, несколько акций, «в акции» без акции в кабинете — только рекомендация', () => {
    const deficit = { forecast: forecast({ turnoverDays: 5 }) };
    expect(evaluate({ ...deficit, promos: [promo({ status: 'CREATED' })] }).status).toBe('RECOMMEND');
    expect(evaluate({ ...deficit, promos: [promo(), promo({ saleId: 400 })] }).status).toBe('RECOMMEND');
    expect(evaluate({ ...deficit, inOffer: true }).status).toBe('RECOMMEND');
  });
});

describe('запуск целиком', () => {
  const change = (skuId: string, rule: AutoDecision['rule']): AutoDecision => ({
    ...evaluate({ forecast: forecast({ turnoverDays: 5 }) }), skuId, title: `SKU-${skuId}`, rule,
  });

  it('предохранитель: не больше 20 изменений, возвраты цены первыми', () => {
    const decisions = [
      ...Array.from({ length: 21 }, (_, index) => change(String(index), 'SLOW')),
      change('revert', 'FLOW_REVERT'),
      change('deficit', 'DEFICIT'),
      evaluate(),
    ];
    const plan = planAutoPricingRun(decisions);
    expect(plan.changes).toHaveLength(AUTO_PRICING_DEFAULTS.maxChangesPerRun);
    expect(plan.changes.slice(0, 2).map((row) => row.skuId)).toEqual(['revert', 'deficit']);
    expect(plan.deferred).toHaveLength(3);
    expect(plan.holds).toHaveLength(1);
  });

  it('отчёт: режим рекомендаций, пропуски сгруппированы, длинный текст режется на сообщения', () => {
    const plan = planAutoPricingRun([change('1', 'DEFICIT'), evaluate({ stock: 0 }), evaluate({ stock: 0 }), evaluate()]);
    const [text] = formatAutoPricingReport(plan, { apply: false, label: '26.09 09:30', stockNote: null, maxChangesPerRun: 20 });
    expect(text).toContain('только рекомендации');
    expect(text).toContain('Рекомендую изменить (1):');
    expect(text).toMatch(/30\s000 → 30\s900/);
    expect(text).toContain('нулевой остаток — 2');

    const many = planAutoPricingRun(Array.from({ length: 60 }, (_, index) => change(String(index), 'SLOW')), { maxChangesPerRun: 60 });
    const chunks = formatAutoPricingReport(many, { apply: true, label: '26.09 19:30', stockNote: 'нет данных', maxChangesPerRun: 60, outcomes: [{ skuId: '0', ok: true, message: 'Uzum: 30 900' }] });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3900)).toBe(true);
    expect(chunks[0]).toContain('Изменения (60):');
    expect(chunks[0]).toContain('✅ Uzum: 30 900');
  });
});
