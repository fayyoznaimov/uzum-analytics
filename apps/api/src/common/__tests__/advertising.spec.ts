import { describe, expect, it } from 'vitest';
import { advertisingEstimate, advertisingEstimateAt, advertisingRateTimeline, baseAdvertisingCode, latestAdvertisingRates, parseAdvertisingEffectiveAt, parseAdvertisingPercent } from '../advertising';

describe('advertising facts', () => {
  it('parses the rate from Russian and Uzbek Uzum descriptions', () => {
    expect(parseAdvertisingPercent('Оплата Буста заказов. Процент за продажу — 3,5%.')).toBe(3.5);
    expect(parseAdvertisingPercent('Buyurtmalarni ko‘paytirish. Sotuvdan foiz — 6%. Namoyish — 2026-08-17')).toBe(6);
    expect(parseAdvertisingPercent('changed wording, 5%')).toBe(5);
    expect(parseAdvertisingPercent('Sotuvdan foiz — 6%', { promotionPercent: null })).toBe(6);
    expect(parseAdvertisingPercent('Sotuvdan foiz — 6%', { percent: '' })).toBe(6);
  });

  it('prefers the latest observed rate independently for every product', () => {
    const now = new Date('2026-08-19T20:00:00Z');
    const rates = latestAdvertisingRates([
      { productExternalId: 'A', serviceAt: '2026-08-10T10:00:00Z', name: 'Sotuvdan foiz — 3%' },
      { productExternalId: 'A', serviceAt: '2026-08-18T10:00:00Z', name: 'Sotuvdan foiz — 6%' },
      { productExternalId: 'B', serviceAt: '2026-08-17T10:00:00Z', name: 'Sotuvdan foiz — 5%' },
      { productExternalId: 'OLD', serviceAt: '2026-06-01T10:00:00Z', name: 'Sotuvdan foiz — 9%' },
    ], { now, lookbackDays: 30 });

    expect(rates.get('A')?.percent).toBe(6);
    expect(rates.get('B')?.percent).toBe(5);
    expect(rates.has('OLD')).toBe(false);
  });

  it('dates a rate by the Uzum display day instead of the later debit day', () => {
    const displayAt = parseAdvertisingEffectiveAt(
      'Sotuvdan foiz — 6%. Namoyish — 2026-05-27',
    );
    expect(displayAt?.toISOString()).toBe('2026-05-26T19:00:00.000Z');

    const timeline = advertisingRateTimeline([{
      productExternalId: 'A',
      serviceAt: '2026-08-19T14:49:43Z',
      name: 'Sotuvdan foiz — 6%. Namoyish — 2026-05-27',
    }]);
    expect(advertisingEstimateAt(
      [{ productExternalId: 'A', amount: 100_000 }],
      timeline,
      new Date('2026-05-27T10:00:00+05:00'),
    ).amount).toBe(6_000);
    expect(advertisingEstimateAt(
      [{ productExternalId: 'A', amount: 100_000 }],
      timeline,
      new Date('2026-08-19T10:00:00+05:00'),
    ).coveredRevenue).toBe(0);
  });

  it('breaks equal serviceAt ties by createdAt and id independently of input order', () => {
    const now = new Date('2026-08-19T20:00:00Z');
    const expenses = [
      { id: 'z', productExternalId: 'A', serviceAt: '2026-08-18T10:00:00Z', createdAt: '2026-08-18T11:00:00Z', name: 'Sotuvdan foiz вЂ” 3%' },
      { id: 'a', productExternalId: 'A', serviceAt: '2026-08-18T10:00:00Z', createdAt: '2026-08-18T12:00:00Z', name: 'Sotuvdan foiz вЂ” 5%' },
      { id: 'b', productExternalId: 'A', serviceAt: '2026-08-18T10:00:00Z', createdAt: '2026-08-18T12:00:00Z', name: 'Sotuvdan foiz вЂ” 6%' },
    ];

    for (const input of [expenses, [...expenses].reverse()]) {
      const rate = latestAdvertisingRates(input, { now }).get('A');
      expect(rate).toMatchObject({ percent: 6, id: 'b' });

      const timeline = advertisingRateTimeline(input);
      expect(advertisingEstimateAt(
        [{ productExternalId: 'A', amount: 100_000 }],
        timeline,
        new Date('2026-08-18T10:00:00Z'),
      ).amount).toBe(6_000);
    }
  });

  it('does not assign one default rate to products without an observed fact', () => {
    const rates = new Map([
      ['A', { productExternalId: 'A', percent: 6, observedAt: new Date('2026-08-18') }],
      ['B', { productExternalId: 'B', percent: 5, observedAt: new Date('2026-08-18') }],
    ]);
    const estimate = advertisingEstimate([
      { productExternalId: 'A', amount: 100_000 },
      { productExternalId: 'B', amount: 200_000 },
      { productExternalId: 'NO_FACT', amount: 300_000 },
    ], rates);

    expect(estimate.amount).toBe(16_000);
    expect(estimate.coveredRevenue).toBe(300_000);
    expect(estimate.totalRevenue).toBe(600_000);
    expect(estimate.effectivePercent).toBeCloseTo(2.666666, 5);
  });

  it('normalizes product ids before looking up current rates', () => {
    const rates = new Map([
      ['A', { productExternalId: 'A', percent: 6, observedAt: new Date('2026-08-18') }],
    ]);

    expect(advertisingEstimate([
      { productExternalId: '  A  ', amount: 100_000 },
    ], rates)).toMatchObject({ amount: 6_000, coveredRevenue: 100_000 });
  });

  it('normalizes advertising refund codes without losing their kind', () => {
    expect(baseAdvertisingCode('return-У000119')).toBe('У000119');
    expect(baseAdvertisingCode('return-У000120')).toBe('У000120');
  });

  it('uses the rate that was observed at the order date instead of rewriting history', () => {
    const timeline = advertisingRateTimeline([
      { productExternalId: 'A', serviceAt: '2026-07-01T10:00:00Z', name: 'Sotuvdan foiz — 3%' },
      { productExternalId: 'A', serviceAt: '2026-08-01T10:00:00Z', name: 'Sotuvdan foiz — 6%' },
    ]);
    expect(advertisingEstimateAt([{ productExternalId: 'A', amount: 100_000 }], timeline, new Date('2026-07-15T10:00:00Z')).amount).toBe(3_000);
    expect(advertisingEstimateAt([{ productExternalId: 'A', amount: 100_000 }], timeline, new Date('2026-08-15T10:00:00Z')).amount).toBe(6_000);
    expect(advertisingEstimateAt([{ productExternalId: 'A', amount: 100_000 }], timeline, new Date('2026-10-15T10:00:00Z')).coveredRevenue).toBe(0);
  });
});
