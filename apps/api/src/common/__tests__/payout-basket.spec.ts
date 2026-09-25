import { describe, expect, it } from 'vitest';
import { basketEligibleDate, buildWithdrawalBasket, calculateEffectivePayout, scheduledPayoutDate } from '../payout-basket';

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
