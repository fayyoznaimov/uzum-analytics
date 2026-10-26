import { describe, expect, it } from 'vitest';
import { evaluateExperiment, evaluateMarketing, excludedExperiment, experimentReport, ordersByWindow, overlappingRange, parseExcludedDays, summarizeExperiments } from '../price-experiment';

const t = (orders: number, days = 7, views = orders * 80) => ({ impressions: views * 9, views, carts: orders * 3, orders, days });

describe('оценка ценового эксперимента', () => {
  it('кейс HAVANA 29.09: сниженные выросли, контроль упал, товар на месте → перетянуло с других цветов', () => {
    // до: 2,6 и 9,4 заказа/день; после: 6,6 и 4,0 (фактические цифры воронки 04.10.2026)
    const result = evaluateExperiment({
      changed: { before: t(18.2, 7), after: t(33, 5) },
      control: { before: t(65.8, 7), after: t(20, 5) },
      priceChangePercent: -4.5,
    });
    expect(result.verdict).toBe('CANNIBALIZED');
    expect(result.ordersChangePercent).toBeGreaterThan(100);
    expect(result.controlOrdersChangePercent).toBeLessThan(-40);
    expect(Math.abs(result.productOrdersChangePercent as number)).toBeLessThan(15);
  });
  it('товар вырос сверх порога → помогло; упал → навредило', () => {
    expect(evaluateExperiment({ changed: { before: t(10), after: t(16) }, control: { before: t(10), after: t(11) }, priceChangePercent: -5 }).verdict).toBe('HELPED');
    expect(evaluateExperiment({ changed: { before: t(14), after: t(6) }, control: { before: t(10), after: t(8) }, priceChangePercent: 4 }).verdict).toBe('HURT');
  });
  it('нет контроля, а у других SKU товара цена тоже менялась → мало данных, а не «помогло» по части товара', () => {
    // HAVANA 29.09: 12 сниженных SKU выросли на 144%, остальные 22 тоже «тронуты» (базовая цена 28.09).
    const result = evaluateExperiment({ changed: { before: t(18), after: t(44) }, control: null, priceChangePercent: -4.5, uncontrolledSkus: 22 });
    expect(result.verdict).toBe('INSUFFICIENT');
    expect(result.productOrdersChangePercent).toBeNull();
    expect(result.note).toBe('нет контроля: у остальных SKU товара с заказами (22) цена в окне тоже менялась — эффект не отделить (заказы SKU +144%)');
    // Изменили все SKU с заказами — товар целиком и есть изменённая часть, вывод возможен.
    expect(evaluateExperiment({ changed: { before: t(18), after: t(44) }, control: null, priceChangePercent: -4.5, uncontrolledSkus: 0 }).verdict).toBe('HELPED');
  });
  it('в пределах ±15% по товару → без эффекта; мало заказов → мало данных', () => {
    expect(evaluateExperiment({ changed: { before: t(10), after: t(11) }, control: null, priceChangePercent: -3 }).verdict).toBe('NO_EFFECT');
    expect(evaluateExperiment({ changed: { before: t(4), after: t(5) }, control: null, priceChangePercent: -3 }).verdict).toBe('INSUFFICIENT');
  });
  it('сводка опыта отдельно по снижениям и повышениям, «мало данных» не учитывается', () => {
    const text = summarizeExperiments([
      { priceChangePercent: -4, verdict: 'CANNIBALIZED' },
      { priceChangePercent: -3, verdict: 'NO_EFFECT' },
      { priceChangePercent: 3, verdict: 'HELPED' },
      { priceChangePercent: 2, verdict: 'INSUFFICIENT' },
    ]);
    expect(text).toContain('снижения цены (2)');
    expect(text).toContain('перетянуло с других цветов 1');
    expect(text).toContain('повышения цены (1): помогло 1');
    expect(summarizeExperiments([{ priceChangePercent: -1, verdict: 'INSUFFICIENT' }])).toBeNull();
  });
});

describe('оценка внешней кампании', () => {
  it('рост товара сверх тренда магазина → помогло, со стоимостью доп. заказа', () => {
    const result = evaluateMarketing({ promoted: { before: t(14), after: t(28) }, control: { before: t(70), after: t(77) }, budget: 1_400_000 });
    expect(result.verdict).toBe('HELPED');
    expect(result.liftPercent).toBeCloseTo(90);
    expect(result.note).toContain('сум за дополнительный заказ');
  });
  it('товар вырос вместе со всем магазином (праздники) → без эффекта', () => {
    const result = evaluateMarketing({ promoted: { before: t(14), after: t(17) }, control: { before: t(70), after: t(84) }, budget: null });
    expect(result.verdict).toBe('NO_EFFECT');
  });
  it('мало заказов → мало данных', () => {
    expect(evaluateMarketing({ promoted: { before: t(3), after: t(4) }, control: null, budget: null }).verdict).toBe('INSUFFICIENT');
  });
});

describe('заказы из учёта магазина по окнам «до/после»', () => {
  const at = (iso: string) => new Date(iso);
  const items = [
    // 21.10 по Ташкенту = день изменения цены: не входит ни в одно окно.
    { orderedAt: at('2026-10-21T10:00:00+05:00'), skuId: '101', productId: '2263224', quantity: 3 },
    { orderedAt: at('2026-10-14T00:10:00+05:00'), skuId: '101', productId: '2263224', quantity: 1 },
    { orderedAt: at('2026-10-20T23:50:00+05:00'), skuId: '102', productId: '2263224', quantity: 2 },
    { orderedAt: at('2026-10-22T08:00:00+05:00'), skuId: '101', productId: '2263224', quantity: 4 },
    { orderedAt: at('2026-10-28T23:00:00+05:00'), skuId: '101', productId: '2263224', quantity: 5 },
    // За пределами окна и без id — не считаются.
    { orderedAt: at('2026-10-13T23:00:00+05:00'), skuId: '101', productId: '2263224', quantity: 9 },
    { orderedAt: at('2026-10-29T00:30:00+05:00'), skuId: '101', productId: '2263224', quantity: 9 },
    { orderedAt: at('2026-10-22T08:00:00+05:00'), skuId: null, productId: null, quantity: 9 },
  ];
  it('SKU: день изменения пропускается, дни — по Ташкенту, только заказы', () => {
    const windows = ordersByWindow(items, { key: 'sku', from: '2026-10-14', to: '2026-10-28', split: '2026-10-21', skipSplitDay: true, days: 7 });
    expect(windows.get('101')?.get('before')).toEqual({ impressions: 0, views: 0, carts: 0, orders: 1, days: 7 });
    expect(windows.get('101')?.get('after')?.orders).toBe(9);
    expect(windows.get('102')?.get('before')?.orders).toBe(2);
    expect(windows.get('102')?.has('after')).toBe(false);
  });
  it('товар: день старта кампании входит в «после»', () => {
    const windows = ordersByWindow(items, { key: 'product', from: '2026-10-14', to: '2026-10-28', split: '2026-10-21', skipSplitDay: false, days: 7 });
    expect(windows.get('2263224')?.get('before')?.orders).toBe(3);
    expect(windows.get('2263224')?.get('after')?.orders).toBe(12);
  });
  it('итоги в Telegram — кусками не длиннее 3900 символов, с заголовком и опытом магазина', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `❔ мало данных — товар ${i}: ${'x'.repeat(120)}`);
    const chunks = experimentReport(lines, 'снижения цены (3): помогло 1');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3900)).toBe(true);
    expect(chunks[0].startsWith('📊 Ценовые эксперименты: итоги через 7 дней\n\n')).toBe(true);
    expect(chunks[chunks.length - 1].endsWith('Опыт магазина за 90 дней: снижения цены (3): помогло 1')).toBe(true);
    expect(chunks.join('\n').split('\n').filter((line) => line.startsWith('❔')).length).toBe(60);
    expect(experimentReport(['✅ помогло — товар 1'], null)).toEqual(['📊 Ценовые эксперименты: итоги через 7 дней\n\n✅ помогло — товар 1']);
  });
});

describe('исключённые дни (самовыкупы, ручная смена цен)', () => {
  it('по умолчанию 14–21.10.2026; свои диапазоны через запятую; off — без исключений', () => {
    expect(parseExcludedDays(undefined)).toEqual([{ from: '2026-10-14', to: '2026-10-21' }]);
    expect(parseExcludedDays('2026-11-05, 2026-11-20..2026-11-10, мусор')).toEqual([{ from: '2026-11-05', to: '2026-11-05' }, { from: '2026-11-10', to: '2026-11-20' }]);
    expect(parseExcludedDays('off')).toEqual([]);
    expect(parseExcludedDays('')).toEqual([]);
  });
  it('окно, задевающее исключённые дни, — «мало данных» с причиной; соседние окна не трогаем', () => {
    const ranges = parseExcludedDays(undefined);
    expect(overlappingRange('2026-10-01', '2026-10-13', ranges)).toBeNull();
    expect(overlappingRange('2026-10-22', '2026-11-05', ranges)).toBeNull();
    expect(overlappingRange('2026-10-07', '2026-10-14', ranges)).toEqual(ranges[0]);
    expect(overlappingRange('2026-10-21', '2026-11-04', ranges)).toEqual(ranges[0]);
    const result = excludedExperiment(-12.5, ranges[0]);
    expect(result).toMatchObject({ verdict: 'INSUFFICIENT', priceChangePercent: -12.5, productOrdersChangePercent: null });
    expect(result.note).toBe('окно задевает исключённые дни 14.10–21.10 (самовыкупы, ручная смена цен) — спрос не оценить');
    expect(summarizeExperiments([{ priceChangePercent: -12.5, verdict: result.verdict }])).toBeNull();
  });
});
