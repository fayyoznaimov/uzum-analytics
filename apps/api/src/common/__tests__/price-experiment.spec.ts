import { describe, expect, it } from 'vitest';
import { evaluateExperiment, evaluateMarketing, summarizeExperiments } from '../price-experiment';

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
