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

  it('не превращает неизвестную прибыль в ноль', () => {
    const summary = buildMiniAppSummary({
      metrics: {
        orderedUnits: 4, orderedRevenue: 400, orderedPayout: 320,
        orderedPotentialProfit: 70, orderedPotentialProfitKnown: false, orderedPotentialProfitEstimate: 70,
        paidUnits: 2, revenue: 200, payout: 160, profit: 55, profitKnown: false,
      },
    }, period);
    expect(summary.profit.net).toBeNull();
    expect(summary.profit.marginPercent).toBeNull();
    expect(summary.ordered.potentialProfit).toBeNull();
    expect(summary.ordered.potentialProfitEstimate).toBe(70);
    expect(summary.notes.join(' ')).toContain('не показана');
    expect(summary.notes.join(' ')).toContain('ожидаемая');
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
        returnedTodayUnits: 1, returnedTodayAmount: 90,
      },
    }, period, new Date('2026-10-12T12:00:00Z'));
    expect(summary.shop).toBe('ParisaHome');
    expect(summary.bought).toEqual({ units: 2, revenue: 1000, payout: 800 });
    expect(summary.profit.net).toBe(250);
    expect(summary.profit.marginPercent).toBeCloseTo(25);
    expect(summary.ordered.potentialProfit).toBe(60);
    expect(summary.expenses.advertisingPercent).toBeCloseTo(6);
    expect(summary.expenses.otherFees).toBe(10);
    expect(summary.expenses.total).toBe(560);
    expect(summary.returns).toEqual({ units: 1, amount: 90 });
    expect(summary.generatedAt).toBe('2026-10-12T12:00:00.000Z');
  });

  it('переживает пустой обзор без магазина и метрик', () => {
    const summary = buildMiniAppSummary({ empty: true }, period);
    expect(summary.bought).toEqual({ units: 0, revenue: 0, payout: 0 });
    expect(summary.profit.net).toBeNull();
    expect(summary.expenses.total).toBe(0);
    expect(summary.shop).toBeNull();
  });
});
