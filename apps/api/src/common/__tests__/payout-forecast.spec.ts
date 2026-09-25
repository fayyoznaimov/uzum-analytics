import { describe, expect, it } from 'vitest';
import { buildPayoutForecast, expectedPayoutAt } from '../payout-forecast';

describe('legacy payout forecast compatibility', () => {
  it('uses dateIssued, not order creation or buyer payment fallback', () => {
    const dateIssued = new Date('2026-07-01T09:00:00+05:00');
    const legacyOrder = {
      paidAt: new Date('2026-06-29T09:00:00+05:00'),
      orderedAt: new Date('2026-06-28T09:00:00+05:00'),
      dateIssued,
    };
    const result = expectedPayoutAt(legacyOrder, 10);
    expect(result.toISOString()).toBe(new Date('2026-07-12T09:00:00+05:00').toISOString());
  });

  it('groups legacy forecast by dateIssued eligibility date', () => {
    const forecast = buildPayoutForecast([
      { id: '1', dateIssued: new Date('2026-07-01T09:00:00+05:00'), payout: 10, units: 1 },
    ], 10, new Date('2026-07-01T12:00:00+05:00'));
    expect(forecast.rows[0].date).toBe('2026-07-12');
  });
});
