import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMiniAppSummary, miniAppRange, normalizeMiniAppPeriod, verifyInitData } from '../telegram-miniapp';

const TOKEN = '123456:AAHtestTokenForSignature';

/** Подписывает initData так же, как это делает Telegram. */
function signInitData(fields: Record<string, string>) {
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function initDataFor(userId: number, authDate: number) {
  return signInitData({
    auth_date: String(authDate),
    query_id: 'AAE',
    user: JSON.stringify({ id: userId, first_name: 'Фаёз', username: 'owner' }),
  });
}

describe('verifyInitData', () => {
  const now = new Date('2026-10-12T10:00:00+05:00');
  const authDate = Math.floor(now.getTime() / 1000) - 60;

  it('принимает подпись Telegram и возвращает пользователя', () => {
    const user = verifyInitData(initDataFor(777, authDate), TOKEN, { now });
    expect(user.id).toBe('777');
    expect(user.username).toBe('owner');
  });

  it('отклоняет подделанные данные при неизменном hash', () => {
    const initData = initDataFor(777, authDate);
    const tampered = initData.replace('777', '888');
    expect(() => verifyInitData(tampered, TOKEN, { now })).toThrow('Подпись Telegram не совпала');
  });

  it('отклоняет подпись, сделанную другим токеном', () => {
    const foreign = new URLSearchParams({ auth_date: String(authDate), user: '{"id":1}', hash: 'a'.repeat(64) }).toString();
    expect(() => verifyInitData(foreign, TOKEN, { now })).toThrow('Подпись Telegram не совпала');
  });

  it('отклоняет устаревшие данные', () => {
    const old = initDataFor(777, authDate - 48 * 3600);
    expect(() => verifyInitData(old, TOKEN, { now })).toThrow('устарели');
  });

  it('требует данные и токен', () => {
    expect(() => verifyInitData('', TOKEN, { now })).toThrow('Нет данных Telegram');
    expect(() => verifyInitData(initDataFor(1, authDate), '', { now })).toThrow('не настроен');
  });
});

describe('miniAppRange', () => {
  it('считает окна периодов от сегодняшнего дня Ташкента', () => {
    expect(miniAppRange('today', '2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-10-12', title: 'Сегодня' });
    expect(miniAppRange('yesterday', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30', title: 'Вчера' });
    expect(miniAppRange('week', '2026-10-12')).toEqual({ from: '2026-10-06', to: '2026-10-12', title: '7 дней' });
    expect(miniAppRange('month', '2026-10-12')).toEqual({ from: '2026-10-01', to: '2026-10-12', title: 'С начала месяца' });
  });

  it('неизвестный период — сегодня', () => {
    expect(normalizeMiniAppPeriod('quarter')).toBe('today');
    expect(normalizeMiniAppPeriod(undefined)).toBe('today');
    expect(normalizeMiniAppPeriod('week')).toBe('week');
  });
});

describe('buildMiniAppSummary', () => {
  const period = { key: 'today' as const, from: '2026-10-12', to: '2026-10-12', title: 'Сегодня' };

  it('не выдаёт неполную прибыль за финальную, но показывает факт «на сейчас»', () => {
    const summary = buildMiniAppSummary({
      metrics: {
        orderedUnits: 4, orderedRevenue: 400, orderedPayout: 320,
        orderedPotentialProfit: 70, orderedPotentialProfitKnown: false, orderedPotentialProfitEstimate: 70,
        paidUnits: 2, revenue: 200, payout: 160, profit: 55, profitKnown: false,
      },
    }, period);
    expect(summary.profit.net).toBeNull();
    expect(summary.profit.marginPercent).toBeNull();
    expect(summary.profit.final).toBe(false);
    expect(summary.profit.current).toBe(55);
    expect(summary.profit.currentMarginPercent).toBeCloseTo(27.5);
    expect(summary.profit.pending).toContain('реклама за свежие дни — Uzum списывает её на следующий день');
    expect(summary.ordered.potentialProfit).toBeNull();
    expect(summary.ordered.potentialProfitEstimate).toBe(70);
    expect(summary.notes.join(' ')).toContain('на сейчас');
    expect(summary.notes.join(' ')).toContain('ожидаемая');
  });

  it('называет конкретные причины, пока период не закрыт', () => {
    const summary = buildMiniAppSummary({
      metrics: {
        paidUnits: 2, revenue: 200, payout: 160, profit: 40, profitKnown: false,
        realizedPayoutPendingOrders: 3, realizedMissingCostItems: 2,
      },
    }, period);
    expect(summary.profit.pending).toEqual([
      'заказов без отчёта Uzum о выплате: 3',
      'позиций без себестоимости: 2',
    ]);
    expect(summary.profit.current).toBe(40);
  });

  it('считает прибыль, маржу и расходы, когда всё известно', () => {
    const summary = buildMiniAppSummary({
      shop: { name: 'ParisaHome' },
      metrics: {
        orderedUnits: 3, orderedRevenue: 300, orderedPayout: 240,
        orderedPotentialProfit: 60, orderedPotentialProfitKnown: true, orderedCostCoverage: 1, orderedAdvertisingCoverage: 1,
        paidUnits: 2, revenue: 1000, payout: 800, profit: 250, profitKnown: true,
        cogs: 300, commission: 120, commissionPercent: 12, marketplaceLogistics: 50,
        advertisingExpense: 60, taxExpense: 20, otherMarketplaceFeesExpense: 5, otherMarketplaceDeductions: 5,
        returnedTodayUnits: 1, returnedTodayAmount: 90, returnedTodayOrders: 1,
      },
    }, period, new Date('2026-10-12T12:00:00Z'));
    expect(summary.shop).toBe('ParisaHome');
    expect(summary.bought).toEqual({ units: 2, revenue: 1000, payout: 800 });
    expect(summary.profit.net).toBe(250);
    expect(summary.profit.marginPercent).toBeCloseTo(25);
    expect(summary.profit.final).toBe(true);
    expect(summary.profit.pending).toEqual([]);
    expect(summary.notes.join(' ')).toContain('Период закрыт');
    expect(summary.ordered.potentialProfit).toBe(60);
    expect(summary.expenses.advertisingPercent).toBeCloseTo(6);
    expect(summary.expenses.otherFees).toBe(10);
    expect(summary.expenses.total).toBe(560);
    expect(summary.returns).toEqual({ units: 1, amount: 90, orders: 1 });
    expect(summary.generatedAt).toBe('2026-10-12T12:00:00.000Z');
  });

  it('переживает пустой обзор без магазина и метрик', () => {
    const summary = buildMiniAppSummary({ empty: true }, period);
    expect(summary.bought).toEqual({ units: 0, revenue: 0, payout: 0 });
    expect(summary.profit.net).toBeNull();
    expect(summary.profit.current).toBeNull();
    expect(summary.expenses.total).toBe(0);
    expect(summary.shop).toBeNull();
  });
});

describe('buildMiniAppSummary: метрики основного экрана', () => {
  const period = { key: 'today' as const, from: '2026-10-12', to: '2026-10-12', title: 'Сегодня' };

  it('переносит кошелёк, движение заказов, рекламу, склад, топ, цели и подсказки', () => {
    const summary = buildMiniAppSummary({
      metrics: {
        revenue: 1000, payout: 800, profit: 250, profitKnown: true,
        orders: 7, paidOrders: 4, waitingOrders: 2, waitingUnits: 3, waitingRevenue: 450,
        returnedTodayUnits: 1, returnedTodayAmount: 90, returnedTodayOrders: 1,
        stockValue: 5_000_000, products: 11, skus: 122, supplies: 2,
        advertisingExpense: 60, orderBoostExpense: 40, topPromotionExpense: 20,
      },
      payoutForecast: {
        holdDays: 4, schedule: 'ежедневно',
        summary: { availableToWithdraw: 300, inReturnHold: 120, dueToday: 50, next7Days: 400, needsReconcile: 10, overallBalance: 900 },
      },
      advertising: { totalExpense: 60, effectivePercent: 6, orderBoostExpense: 40, topPromotionExpense: 20, provisionalOrderBoostExpense: 15, hasEstimate: true, freshExpenseMayBeIncomplete: true },
      inventorySummary: { skuCount: 122, endingSoonSkus: 4, recommendedSupply: 310, marketplaceTotal: 1200, availableForSale: 1100, potentialPayout: 9_000_000, reportAsOf: new Date('2026-10-12T06:00:00Z') },
      risks: [{ title: 'Полотенце J471', sku: 'FAYYOZ-J471-СЕРЫЙ-банны', stock: 3, daysLeft: 2, recommendedSupply: 40, status: 'Заканчивается' }],
      topProducts: [
        { title: 'J471 комплект', units: 5.4, revenue: 700, profit: 150, profitKnown: true },
        { title: 'J403 банный', units: 2, revenue: 300, profit: 60, profitKnown: false },
      ],
      goals: [
        { metric: 'REVENUE', targetValue: 2000, current: 1000, progress: 50 },
        { metric: 'PROFIT', targetValue: 500, current: null, progress: null },
      ],
      staleWaitingOrders: { cutoffDays: 7, count: 2, units: 3, amount: 400 },
      waterfall: [
        { key: 'gross', label: '1. Сумма оплаченных заказов', value: 1000, type: 'income', percent: 100 },
        { key: 'profit', label: '13. Чистая прибыль', value: 250, type: 'profit', percent: 25 },
      ],
      chart: Array.from({ length: 20 }, (_, index) => ({ label: `2026-10-${String(index + 1).padStart(2, '0')}`, revenue: index })),
      chartGranularity: 'day',
      insights: [{ tone: 'warning', title: 'Источник рекламных расходов', text: 'ДРР 6%' }],
    }, period);
    expect(summary.wallet).toEqual({
      availableToWithdraw: 300, inReturnHold: 120, dueToday: 50, next7Days: 400,
      needsReconcile: 10, overallBalance: 900, holdDays: 4, schedule: 'ежедневно',
    });
    expect(summary.orders).toEqual({ created: 7, paid: 4, waiting: 2, waitingUnits: 3, waitingRevenue: 450 });
    expect(summary.returns).toEqual({ units: 1, amount: 90, orders: 1 });
    expect(summary.advertising).toEqual({ expense: 60, percent: 6, orderBoost: 40, topPromotion: 20, estimate: 15, hasEstimate: true, mayBeIncomplete: true });
    expect(summary.stock.endingSoon).toBe(4);
    expect(summary.stock.recommendedSupply).toBe(310);
    expect(summary.stock.value).toBe(5_000_000);
    expect(summary.risks[0].sku).toBe('FAYYOZ-J471-СЕРЫЙ-банны');
    // Прибыль по товару без полных данных — null, а не ноль.
    expect(summary.topProducts.map((row) => row.profit)).toEqual([150, null]);
    expect(summary.topProducts[0].units).toBe(5);
    expect(summary.goals).toEqual([{ metric: 'REVENUE', current: 1000, target: 2000, progress: 50 }]);
    expect(summary.stale).toEqual({ cutoffDays: 7, count: 2, units: 3, amount: 400 });
    expect(summary.waterfall[1]).toEqual({ key: 'profit', label: '13. Чистая прибыль', value: 250, percent: 25, kind: 'profit' });
    // На телефоне влезает только хвост периода.
    expect(summary.chart.points).toHaveLength(14);
    expect(summary.chart.points[0].label).toBe('2026-10-07');
    expect(summary.insights[0].title).toBe('Источник рекламных расходов');
    expect(summary.catalog).toEqual({ products: 11, skus: 122, supplies: 2 });
  });

  it('не показывает итог разложения, пока прибыль не финальна, и помечает неполные части', () => {
    const summary = buildMiniAppSummary({
      metrics: {
        revenue: 1000, payout: 800, profit: 200, profitKnown: false,
        realizedPayoutPendingOrders: 2, realizedMissingCostItems: 1,
      },
      waterfall: [
        { key: 'payout', label: '5. Выдаётся продавцу', value: 800, type: 'subtotal', percent: 80 },
        { key: 'productCost', label: '6. Себестоимость товара', value: -300, type: 'expense', percent: 30 },
        { key: 'profit', label: '13. Чистая прибыль', value: 200, type: 'profit', percent: 20 },
      ],
    }, period);
    expect(summary.waterfall.find((row) => row.key === 'profit')?.value).toBeNull();
    expect(summary.waterfall.find((row) => row.key === 'payout')?.kind).toBe('partial');
    expect(summary.waterfall.find((row) => row.key === 'productCost')?.kind).toBe('partial');
  });

  it('переживает обзор без кошелька, склада и списков', () => {
    const summary = buildMiniAppSummary({ empty: true }, period);
    expect(summary.wallet).toBeNull();
    expect(summary.risks).toEqual([]);
    expect(summary.topProducts).toEqual([]);
    expect(summary.goals).toEqual([]);
    expect(summary.chart.points).toEqual([]);
    expect(summary.insights).toEqual([]);
    expect(summary.stock.endingSoon).toBe(0);
  });
});
