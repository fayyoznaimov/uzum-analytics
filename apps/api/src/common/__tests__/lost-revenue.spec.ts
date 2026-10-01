import { describe, expect, it } from 'vitest';
import { lostRevenueForSku } from '../lost-revenue';

const d = (value: string) => new Date(value);
const from = d('2026-09-01T00:00:00+05:00');
const to = d('2026-09-11T00:00:00+05:00'); // 10 ташкентских дней

describe('упущенная выручка', () => {
  it('дни без остатка считаются по шагам снапшотов, скорость — по дням в наличии', () => {
    // В наличии 01–04 (4 дня), ноль 05–08 (4 дня), снова в наличии 09–10 (2 дня).
    const snapshots = [
      { at: d('2026-08-28T10:00:00+05:00'), amount: 5 },
      { at: d('2026-09-05T09:00:00+05:00'), amount: 0 },
      { at: d('2026-09-09T09:00:00+05:00'), amount: 7 },
    ];
    const sales = [
      { at: d('2026-09-02T13:00:00+05:00'), units: 2, revenue: 126_000 },
      { at: d('2026-09-03T13:00:00+05:00'), units: 1, revenue: 63_000 },
    ];
    const row = lostRevenueForSku(snapshots, sales, from, to);
    expect(row.outOfStockDays).toBe(4);
    expect(row.inStockDays).toBe(6);
    expect(row.dailyRate).toBeCloseTo(0.5);
    expect(row.lostUnitsEstimate).toBeCloseTo(2);
    expect(row.lostRevenueEstimate).toBeCloseTo(126_000); // 2 шт. × средняя цена 63 000
  });
  it('без продаж скорость неизвестна — потери не выдумываются', () => {
    const row = lostRevenueForSku([{ at: d('2026-09-01T10:00:00+05:00'), amount: 0 }], [], from, to);
    expect(row.outOfStockDays).toBe(10);
    expect(row.dailyRate).toBeNull();
    expect(row.lostRevenueEstimate).toBe(0);
  });
  it('без снапшотов дни не считаются вовсе (нет данных ≠ ноль остатка)', () => {
    const row = lostRevenueForSku([], [{ at: d('2026-09-02T13:00:00+05:00'), units: 3, revenue: 150_000 }], from, to);
    expect(row.outOfStockDays).toBe(0);
    expect(row.inStockDays).toBe(0);
    expect(row.lostRevenueEstimate).toBe(0);
  });
  it('до первого снапшота остаток принимается равным первому снапшоту', () => {
    // Первый снапшот 05.09 = 0: значит и 01–04 считаем нулевыми.
    const row = lostRevenueForSku([{ at: d('2026-09-05T09:00:00+05:00'), amount: 0 }], [], from, to);
    expect(row.outOfStockDays).toBe(10);
  });
});
