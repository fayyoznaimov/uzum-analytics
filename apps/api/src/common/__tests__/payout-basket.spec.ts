import { describe, expect, it } from 'vitest';
import { basketEligibleDate, buildWithdrawalBasket, calculateEffectivePayout, nextBusinessDay, normalizeHoldDays, normalizePayoutSchedule, scheduledPayoutDate } from '../payout-basket';

const d = (iso: string) => new Date(`${iso}T12:00:00+05:00`);

describe('withdrawal basket', () => {
  it('puts issued order into withdrawal basket after the configured 10 days', () => {
    expect(basketEligibleDate(d('2026-07-01'), 10)).toBe('2026-07-12');
  });

  it('calculates Uzum biweekly schedule from issued date windows', () => {
    expect(scheduledPayoutDate(d('2026-07-01'), 'BIWEEKLY', 10)).toBe('2026-07-21');
    expect(scheduledPayoutDate(d('2026-07-11'), 'BIWEEKLY', 10)).toBe('2026-08-07');
    expect(scheduledPayoutDate(d('2026-07-27'), 'BIWEEKLY', 10)).toBe('2026-08-21');
  });

  it('calculates weekly and monthly schedule windows', () => {
    expect(scheduledPayoutDate(d('2026-07-03'), 'WEEKLY', 10)).toBe('2026-07-14');
    expect(scheduledPayoutDate(d('2026-07-04'), 'WEEKLY', 10)).toBe('2026-07-21');
    expect(scheduledPayoutDate(d('2026-07-27'), 'MONTHLY', 10)).toBe('2026-09-07');
  });

  it('does not prorate an API payout that is already net of a partial return', () => {
    const calc = calculateEffectivePayout({ payout: 41_050, gross: 60_000, units: 2, returnedUnits: 1 });
    expect(calc.netUnits).toBe(1);
    expect(calc.effectivePayout).toBe(41_050);
    expect(calc.effectiveGross).toBe(60_000);
    expect(calc.returnReserve).toBe(0);
  });

  it('keeps an explicit return amount informational without subtracting it twice', () => {
    const calc = calculateEffectivePayout({ payout: 41_050, gross: 60_000, units: 2, returnedUnits: 1, returnAmount: 18_950 });
    expect(calc.effectivePayout).toBe(41_050);
    expect(calc.returnReserve).toBe(18_950);
  });

  it('keeps the already-net payout intact when building the basket', () => {
    const result = buildWithdrawalBasket([
      { id: 'partial', issuedAt: d('2026-07-01'), gross: 60_000, payout: 41_050, units: 2, returnedUnits: 1 },
    ], { holdDays: 10, schedule: 'BIWEEKLY', now: d('2026-07-15') });
    expect(result.rows[0].amount).toBe(41_050);
    expect(result.rows[0].units).toBe(1);
    expect(result.rows[0].returnedUnits).toBe(1);
  });

  it('separates hold, available basket and scheduled bank amounts', () => {
    const result = buildWithdrawalBasket([
      { id: '1', issuedAt: d('2026-07-01'), gross: 100_000, payout: 80_000, units: 1 },
      { id: '2', issuedAt: d('2026-07-10'), gross: 50_000, payout: 40_000, units: 1 },
      { id: '3', issuedAt: null, gross: 30_000, payout: 25_000, units: 1 },
    ], { holdDays: 10, schedule: 'BIWEEKLY', now: d('2026-07-15') });
    expect(result.summary.availableToWithdraw).toBe(80_000);
    expect(result.summary.inReturnHold).toBe(40_000);
    expect(result.summary.notIssuedAmount).toBe(25_000);
    expect(result.summary.basketNext7).toBe(40_000);
    expect(result.rows[0].status).toBe('AVAILABLE');
    expect(result.basketDailyRows[0].date).toBe('2026-07-12');
    expect(result.basketDailyRows[0].basketStatusLabel).toBe('В корзине вывода');
    expect(result.payoutDailyRows[0].date).toBe('2026-07-21');
    expect(result.payoutDailyRows[0].amount).toBe(120_000);
  });
});

describe('нормализация holdDays и графиков выплат', () => {
  it('нормализует holdDays: границы 0 и 90, NaN и строки', () => {
    expect(normalizeHoldDays(0)).toBe(0);
    expect(normalizeHoldDays(90)).toBe(90);
    expect(normalizeHoldDays(91)).toBe(90);
    expect(normalizeHoldDays(-1)).toBe(0);
    expect(normalizeHoldDays(10.9)).toBe(10);
    expect(normalizeHoldDays('15')).toBe(15);
    expect(normalizeHoldDays(NaN)).toBe(10);
    expect(normalizeHoldDays('abc')).toBe(10);
    expect(normalizeHoldDays(undefined)).toBe(10);
    // Зафиксировано текущее поведение: Number(null) === 0, поэтому null даёт 0 дней удержания, а не fallback 10.
    expect(normalizeHoldDays(null)).toBe(0);
  });

  it('holdDays ≠ 10 сдвигает дату входа в корзину, выше 90 — обрезается', () => {
    expect(basketEligibleDate(d('2026-07-01'), 0)).toBe('2026-07-02');
    expect(basketEligibleDate(d('2026-07-01'), 90)).toBe('2026-09-30');
    expect(basketEligibleDate(d('2026-07-01'), 999)).toBe('2026-09-30');
  });

  it('нормализует график выплат и подставляет BIWEEKLY для мусора', () => {
    expect(normalizePayoutSchedule(' daily ')).toBe('DAILY');
    expect(normalizePayoutSchedule('weekly')).toBe('WEEKLY');
    expect(normalizePayoutSchedule('что-то ещё')).toBe('BIWEEKLY');
    expect(normalizePayoutSchedule(null)).toBe('BIWEEKLY');
  });

  it('переносит выплату с выходного дня на понедельник', () => {
    expect(nextBusinessDay('2026-07-18')).toBe('2026-07-20'); // суббота
    expect(nextBusinessDay('2026-07-19')).toBe('2026-07-20'); // воскресенье
    expect(nextBusinessDay('2026-07-20')).toBe('2026-07-20'); // будний день не двигается
    expect(scheduledPayoutDate(d('2026-06-05'), 'BIWEEKLY', 10)).toBe('2026-06-22'); // табличная дата 21.06.2026 — воскресенье
  });

  it('график DAILY платит на следующий рабочий день после входа в корзину', () => {
    expect(scheduledPayoutDate(d('2026-07-03'), 'DAILY', 10)).toBe('2026-07-14');
    expect(scheduledPayoutDate(d('2026-07-01'), 'DAILY', 10)).toBe('2026-07-13'); // 12.07.2026 — воскресенье
  });

  it('подтягивает табличную дату выплаты к дню входа в корзину, если она раньше конца удержания', () => {
    // Выдача 25.02.2026: по таблице BIWEEKLY выплата 07.03, но удержание кончается только 08.03.
    // Осознанно зафиксированная семантика: выплата подтягивается к eligible-дню (08.03 — воскресенье → 09.03).
    expect(basketEligibleDate(d('2026-02-25'), 10)).toBe('2026-03-08');
    expect(scheduledPayoutDate(d('2026-02-25'), 'BIWEEKLY', 10)).toBe('2026-03-09');
  });
});

describe('корзина: возвраты, статусы и границы суток', () => {
  it('клампит отрицательную выплату заказа в 0 — возврат больше цены (зафиксировано текущее поведение)', () => {
    const calc = calculateEffectivePayout({ payout: -5_000, gross: -10_000, units: 1 });
    expect(calc.effectivePayout).toBe(0);
    expect(calc.effectiveGross).toBe(0);
    const empty = buildWithdrawalBasket([
      { id: 'neg', issuedAt: d('2026-07-01'), gross: -10_000, payout: -5_000, units: 1 },
    ], { now: d('2026-07-15') });
    expect(empty.rows).toHaveLength(0); // заказ без выплаты и без резерва целиком выпадает из корзины
    expect(empty.summary.totalTracked).toBe(0);
    const withReserve = buildWithdrawalBasket([
      { id: 'neg2', issuedAt: d('2026-07-01'), gross: -10_000, payout: -5_000, units: 1, returnAmount: 3_000 },
    ], { now: d('2026-07-15') });
    expect(withReserve.rows[0].amount).toBe(0);
    expect(withReserve.rows[0].returnReserve).toBe(3_000);
  });

  it('помечает просроченную по графику выплату как NEEDS_RECONCILE', () => {
    const result = buildWithdrawalBasket([
      { id: '1', issuedAt: d('2026-07-01'), gross: 100_000, payout: 80_000, units: 1 },
    ], { holdDays: 10, schedule: 'BIWEEKLY', now: d('2026-08-01') });
    expect(result.rows[0].status).toBe('NEEDS_RECONCILE');
    expect(result.basketDailyRows[0].basketStatusLabel).toBe('Нужно сверить');
    expect(result.basketDailyRows[0].daysUntilPayout).toBe(-11);
    expect(result.payoutDailyRows[0].status).toBe('NEEDS_RECONCILE');
    expect(result.summary.needsReconcile).toBe(80_000);
    expect(result.summary.dueToday).toBe(0);
  });

  it('помечает выплату по графику сегодня как DUE_TODAY и агрегирует payoutDailyRows по дате выплаты', () => {
    const result = buildWithdrawalBasket([
      { id: '1', issuedAt: d('2026-07-01'), gross: 100_000, payout: 80_000, units: 1 },
      { id: '2', issuedAt: d('2026-07-05'), gross: 50_000, payout: 40_000, units: 1 },
    ], { holdDays: 10, schedule: 'BIWEEKLY', now: d('2026-07-21') });
    expect(result.rows.map((row) => row.status)).toEqual(['DUE_TODAY', 'DUE_TODAY']);
    expect(result.basketDailyRows[0].basketStatusLabel).toBe('По графику сегодня');
    expect(result.payoutDailyRows).toHaveLength(1);
    expect(result.payoutDailyRows[0]).toMatchObject({ date: '2026-07-21', status: 'DUE_TODAY', amount: 120_000, orders: 2, basketFrom: '2026-07-12', basketTo: '2026-07-16', basketDays: 5 });
    expect(result.summary.dueToday).toBe(120_000);
  });

  it('считает корзину от ташкентского дня выдачи, а не от UTC', () => {
    // 20:00 UTC = 01:00 следующего дня в Ташкенте — удержание стартует со следующего дня
    expect(basketEligibleDate(new Date('2026-07-01T20:00:00Z'), 10)).toBe('2026-07-13');
    expect(basketEligibleDate(new Date('2026-07-01T18:59:00Z'), 10)).toBe('2026-07-12');
    const result = buildWithdrawalBasket([
      { id: 'late', issuedAt: new Date('2026-07-01T21:00:00Z'), gross: 10_000, payout: 8_000, units: 1 },
    ], { holdDays: 10, schedule: 'BIWEEKLY', now: d('2026-07-12') });
    expect(result.rows[0].date).toBe('2026-07-13'); // выдан 02.07 по Ташкенту
    expect(result.rows[0].status).toBe('HOLD');
    expect(result.summary.availableToWithdraw).toBe(0);
  });
});
