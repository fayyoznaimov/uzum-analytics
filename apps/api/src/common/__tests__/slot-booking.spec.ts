import { describe, expect, it } from 'vitest';
import { FreeSlot, formatSlot, formatWindow, pickSlot, slotInWindow } from '../slot-booking';

const now = new Date('2026-10-06T12:00:00+05:00');
const slot = (from: string, patch: Partial<FreeSlot> = {}): FreeSlot => ({ id: from, from: new Date(from), to: new Date(new Date(from).getTime() + 3_600_000), capacity: 5, ...patch });
const d = (value: string) => new Date(`${value}T12:00:00+05:00`);

describe('выбор тайм-слота под желаемую дату', () => {
  const slots = [slot('2026-10-09T10:00:00+05:00'), slot('2026-10-07T09:00:00+05:00'), slot('2026-10-08T14:00:00+05:00'), slot('2026-10-05T10:00:00+05:00')];
  it('без окна — самый ранний будущий слот', () => {
    expect(pickSlot(slots, { from: null, to: null }, now)?.id).toBe('2026-10-07T09:00:00+05:00');
  });
  it('окно одного дня — слот именно этого дня', () => {
    expect(pickSlot(slots, { from: d('2026-10-08'), to: d('2026-10-08') }, now)?.id).toBe('2026-10-08T14:00:00+05:00');
  });
  it('окно «с»: берёт первый не раньше даты; окно «по»: не позже', () => {
    expect(pickSlot(slots, { from: d('2026-10-08'), to: null }, now)?.id).toBe('2026-10-08T14:00:00+05:00');
    expect(pickSlot(slots, { from: null, to: d('2026-10-07') }, now)?.id).toBe('2026-10-07T09:00:00+05:00');
  });
  it('нет слотов в окне — null', () => {
    expect(pickSlot(slots, { from: d('2026-10-10'), to: d('2026-10-12') }, now)).toBeNull();
  });
  it('день считается по Ташкенту: слот 23:30 UTC 7-го — это 8-е по Ташкенту', () => {
    const late = slot('2026-10-07T23:30:00Z');
    expect(slotInWindow(late, { from: d('2026-10-08'), to: d('2026-10-08') })).toBe(true);
    expect(slotInWindow(late, { from: d('2026-10-07'), to: d('2026-10-07') })).toBe(false);
  });
  it('пропускает слоты без времени, в прошлом и с нулевой вместимостью', () => {
    expect(pickSlot([slot('2026-10-08T10:00:00+05:00', { from: null })], { from: null, to: null }, now)).toBeNull();
    expect(pickSlot([slot('2026-10-08T10:00:00+05:00', { capacity: 0 })], { from: null, to: null }, now)).toBeNull();
    expect(pickSlot([slot('2026-10-05T10:00:00+05:00')], { from: null, to: null }, now)).toBeNull();
  });
  it('форматирует слот и окно по-русски', () => {
    expect(formatSlot(slot('2026-10-08T14:00:00+05:00'))).toBe('08.10.2026 14:00–15:00');
    expect(formatWindow({ from: d('2026-10-08'), to: d('2026-10-08') })).toBe('08.10.2026');
    expect(formatWindow({ from: d('2026-10-08'), to: d('2026-10-10') })).toBe('с 08.10.2026 по 10.10.2026');
    expect(formatWindow({ from: null, to: null })).toBe('любая дата');
  });
});
