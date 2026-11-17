import { describe, expect, it } from 'vitest';
import { FreeSlot, fboBookRequest, fboGroupKey, fboReservation, fboSlotsRequest, fboStockOf, formatSlot, formatWindow, parseFboSlots, pickSlot, slotInWindow } from '../slot-booking';

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

describe('слоты FBO через кабинет', () => {
  // Формат ответа кабинета 17.11.2026: накладная 4198545 — слот 01.01.2027 09:00–21:00.
  const raw = { invoiceNumber: '110004198545', stock: { id: 34, poolSource: 'FULLFILMENT', title: 'Фулфилмент центр' }, timeSlotReservation: { id: 68511213, status: 'RESERVED', timeFrom: 1798776000000, timeTo: 1798819200000 } };
  it('склад, пул и забронированный слот берутся из данных накладной', () => {
    expect(fboStockOf(raw)).toEqual({ stockId: 34, poolSource: 'FULLFILMENT' });
    expect(fboStockOf({ stock: { id: 34 } })).toEqual({ stockId: 34, poolSource: 'FULLFILMENT' });
    expect(fboStockOf({})).toBeNull();
    expect(formatSlot({ id: '', from: fboReservation(raw)!.from, to: fboReservation(raw)!.to, capacity: 1 })).toBe('01.01.2027 09:00–21:00');
    expect(fboReservation({ timeSlotReservation: null })).toBeNull();
  });
  it('запросы поиска и брони — как у кабинета', () => {
    const stock = { stockId: 34, poolSource: 'FULLFILMENT' };
    expect(fboSlotsRequest(['4240863', '4240865'], stock, new Date(1794898411643))).toEqual({ invoiceIds: [4240863, 4240865], poolSource: 'FULLFILMENT', timeFrom: 1794898411643 });
    const [slot] = parseFboSlots({ payload: { timeSlots: [{ timeFrom: 1795233600000, timeTo: 1795240800000 }] } });
    expect(fboBookRequest(slot, ['4240868'], stock)).toEqual({ timeFrom: 1795233600000, invoiceIds: [4240868], stockId: 34, poolSource: 'FULLFILMENT' });
  });
  it('пустой список — слотов нет; незнакомый ответ — ошибка, а не «нет слотов»', () => {
    expect(parseFboSlots({ payload: { timeSlots: [] }, timestamp: '2026-11-17T05:53:29' })).toEqual([]);
    expect(() => parseFboSlots({ payload: {} })).toThrow(/незнакомом формате/);
  });
  it('слот без вместимости не отбрасывается и выбирается по окну', () => {
    const slots = parseFboSlots({ payload: { timeSlots: [{ timeFrom: Date.parse('2026-11-20T10:00:00+05:00'), timeTo: Date.parse('2026-11-20T12:00:00+05:00') }, { timeFrom: Date.parse('2026-12-01T09:00:00+05:00'), timeTo: Date.parse('2026-12-01T11:00:00+05:00') }] } });
    expect(pickSlot(slots, { from: null, to: null }, now)?.id).toBe(String(Date.parse('2026-11-20T10:00:00+05:00')));
    expect(pickSlot(slots, { from: d('2026-11-28'), to: d('2026-12-05') }, now)?.id).toBe(String(Date.parse('2026-12-01T09:00:00+05:00')));
  });
  it('накладные с тем же складом, окном и режимом — одна группа', () => {
    const stock = { stockId: 34, poolSource: 'FULLFILMENT' };
    const w = { from: d('2026-11-28'), to: d('2026-12-05') };
    expect(fboGroupKey(stock, w, true)).toBe(fboGroupKey(stock, { from: new Date('2026-11-28T00:00:00+05:00'), to: new Date('2026-12-05T23:59:59+05:00') }, true));
    expect(fboGroupKey(stock, w, true)).not.toBe(fboGroupKey(stock, w, false));
    expect(fboGroupKey(stock, w, true)).not.toBe(fboGroupKey(stock, { from: null, to: null }, true));
  });
});
