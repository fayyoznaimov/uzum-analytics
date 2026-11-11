import { describe, expect, it } from 'vitest';
import { cabinetBalanceUsable, parseCabinetBalance } from '../cabinet-balance';

// Ответы кабинета 11.11.2026 (finance/payout-schedule и finance/balance), без лишних полей.
const schedule = {
  current: { schedule: 'TWICE_A_MONTH', feePercent: 0, settlementAccountId: 1 },
  nextPayout: { amount: 6880190, date: '2026-11-21', payoutModel: 'STATUS', periodTo: '2026-11-10' },
  available: [],
};
const balance = { total: 41649459, returnsPerMonthSum: 7787100, expensesStatementDetail: { expenses: [] } };

describe('баланс из кабинета Uzum', () => {
  it('берёт «к выплате», дату, «накоплено по» и общий баланс', () => {
    expect(parseCabinetBalance(schedule, balance)).toEqual({
      nextPayoutAmount: 6880190, nextPayoutDate: '2026-11-21', periodTo: '2026-11-10', payoutModel: 'STATUS', schedule: 'TWICE_A_MONTH', totalBalance: 41649459,
    });
  });

  it('пустой nextPayout при узнаваемом ответе — ноль к выплате, а не ошибка; без balance общий баланс неизвестен', () => {
    expect(parseCabinetBalance({ current: { schedule: 'TWICE_A_MONTH' }, nextPayout: null }, null)).toMatchObject({ nextPayoutAmount: 0, nextPayoutDate: null, totalBalance: null });
  });

  it('незнакомая форма ответа — ошибка, а не ноль на экране', () => {
    expect(() => parseCabinetBalance({ items: [] }, balance)).toThrow(/неожиданная форма/);
    expect(() => parseCabinetBalance({ nextPayout: { amount: 'много', date: '2026-11-21' } }, balance)).toThrow(/не число/);
    expect(() => parseCabinetBalance({ nextPayout: { amount: 100 } }, balance)).toThrow(/нет даты/);
  });

  it('снимок годится, пока свежий и его выплата ещё впереди', () => {
    const now = new Date('2026-11-11T14:00:00Z');
    const fresh = { fetchedAt: new Date('2026-11-11T13:50:00Z'), nextPayoutDate: '2026-11-21' };
    expect(cabinetBalanceUsable(fresh, now, '2026-11-11')).toBe(true);
    // Кабинет недоступен больше 6 часов (Cloudflare) — на экране уже наш расчёт.
    expect(cabinetBalanceUsable({ ...fresh, fetchedAt: new Date('2026-11-11T07:00:00Z') }, now, '2026-11-11')).toBe(false);
    // День выплаты: Uzum уже забрал накопленное, вчерашняя сумма «к выплате 21.11» не про сегодняшний остаток.
    expect(cabinetBalanceUsable({ fetchedAt: new Date('2026-11-20T18:50:00Z'), nextPayoutDate: '2026-11-21' }, new Date('2026-11-20T19:30:00Z'), '2026-11-21')).toBe(false);
    expect(cabinetBalanceUsable(null, now, '2026-11-11')).toBe(false);
  });
});
