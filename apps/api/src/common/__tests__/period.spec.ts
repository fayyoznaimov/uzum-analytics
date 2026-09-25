import { describe, expect, it } from 'vitest';
import { resolvePeriod, tashkentHour, tashkentKey } from '../period';

describe('period selection', () => {
  it('swaps reversed dates and calculates inclusive days', () => {
    const p = resolvePeriod({ from: '2026-07-13', to: '2026-07-01', compare: true });
    expect(p.fromDate).toBe('2026-07-01');
    expect(p.toDate).toBe('2026-07-13');
    expect(p.days).toBe(13);
    expect(p.prevFromDate).toBe('2026-06-18');
    expect(p.prevToDate).toBe('2026-06-30');
  });
  it('uses Asia/Tashkent day and hour', () => {
    const date = new Date('2026-07-12T20:30:00Z');
    expect(tashkentKey(date)).toBe('2026-07-13');
    expect(tashkentHour(date)).toBe(1);
  });
});
