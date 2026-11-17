import { describe, expect, it } from 'vitest';
import { FreeSlot, extensionCovers, fboBookRequest, fboDecide, fboExtensionTask, fboInvoiceState, fboEarliestStart, fboGroupKey, fboLeadHours, fboReservation, fboSlotsRequest, fboStockOf, formatSlot, formatWindow, parseFboExtensionReport, parseFboSlots, pickSlot, slotInWindow } from '../slot-booking';

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
    expect(fboSlotsRequest(['4240863', '4240865'], stock, new Date(1794894811643))).toEqual({ invoiceIds: [4240863, 4240865], poolSource: 'FULLFILMENT', timeFrom: 1794898411643 });
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
  it('запас «как минимум за 2 дня»: слоты ближе 48 часов не берём', () => {
    expect(fboLeadHours(undefined)).toBe(48);
    expect(fboLeadHours('')).toBe(48);
    expect(fboLeadHours('24')).toBe(24);
    expect(fboLeadHours('abc')).toBe(48);
    const at = (iso: string) => ({ timeFrom: Date.parse(iso), timeTo: Date.parse(iso) + 7_200_000 });
    const slots = parseFboSlots({ payload: { timeSlots: [at('2026-11-18T10:00:00+05:00'), at('2026-11-19T11:00:00+05:00'), at('2026-11-19T13:00:00+05:00')] } });
    const booking = new Date('2026-11-17T12:00:00+05:00');
    expect(pickSlot(slots, { from: null, to: null }, fboEarliestStart(booking, 48))?.from?.toISOString()).toBe(new Date('2026-11-19T13:00:00+05:00').toISOString());
    expect(pickSlot(slots, { from: null, to: null }, fboEarliestStart(booking, 0))?.from?.toISOString()).toBe(new Date('2026-11-18T10:00:00+05:00').toISOString());
  });
});

describe('проверка слотов из Chrome-расширения', () => {
  const stock = { stockId: 34, poolSource: 'FULLFILMENT' };
  const at = new Date('2026-11-17T13:00:00+05:00');
  it('задание — номера накладных, склад и окно днями по Ташкенту', () => {
    expect(fboExtensionTask('k', '92776', ['4240863', '4240865'], '№1, №2', stock, { from: new Date('2026-11-27T19:30:00Z'), to: null }, true)).toEqual({
      key: 'k', shopId: '92776', invoiceIds: ['4240863', '4240865'], labels: '№1, №2', stockId: 34, poolSource: 'FULLFILMENT', windowFrom: '2026-11-28', windowTo: null, autoBook: true, reservedFrom: null,
    });
  });
  it('сервер молчит, только пока отчёт расширения свежий (10 минут)', () => {
    const now = at.getTime();
    expect(extensionCovers(null, now)).toBe(false);
    expect(extensionCovers(now - 9 * 60_000, now)).toBe(true);
    expect(extensionCovers(now - 11 * 60_000, now)).toBe(false);
    expect(extensionCovers(now + 60_000, now)).toBe(false);
  });
  it('отчёт: бронь, ошибка, слот уже есть; битые строки отбрасываются', () => {
    const from = Date.parse('2026-11-20T09:00:00+05:00');
    const results = parseFboExtensionReport({ results: [
      { invoiceIds: ['4240863', 4240865, '4240863'], checkedAt: at.getTime() - 60_000, slots: 3, matched: { timeFrom: from, timeTo: from + 7_200_000 }, booked: true },
      { invoiceIds: ['4240868'], error: '  кабинет не принял токен (401)  ', checkedAt: 1 },
      { invoiceIds: ['4240868'], reserved: { timeFrom: String(from), timeTo: null } },
      { invoiceIds: ['../../etc'] },
      { invoiceIds: [] },
      { invoiceIds: ['4240868'], booked: true },
    ] }, at);
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ invoiceIds: ['4240863', '4240865'], slotsCount: 3, booked: true, error: null, checkedAt: new Date(at.getTime() - 60_000) });
    expect(results[0].matched?.from?.getTime()).toBe(from);
    expect(results[1]).toMatchObject({ error: 'кабинет не принял токен (401)', checkedAt: at, matched: null, booked: false });
    expect(results[2].reserved?.from.getTime()).toBe(from);
    expect(results[3]).toMatchObject({ booked: false, matched: null });
    expect(parseFboExtensionReport({})).toEqual([]);
  });
});

describe('перенос на более ранний слот', () => {
  const now = new Date('2026-11-17T13:00:00+05:00');
  const ms = (iso: string) => Date.parse(iso);
  const slotAt = (iso: string): FreeSlot => ({ id: String(ms(iso)), from: new Date(iso), to: new Date(ms(iso) + 3_600_000), capacity: Number.NaN });
  // Ответ кабинета 17.11.2026 после ручной брони владельца: 29.11 06:00, смен осталось 2.
  const invoice = (from: string | null, remaining: number | null, status = 'CREATED') => ({
    id: 4240863, invoiceStatus: { color: '#000000', text: 'Yaratilgan', value: status },
    timeSlotReservation: from ? { id: 1, status: 'RESERVED', timeFrom: ms(from), timeTo: ms(from) + 5_400_000, timeSlots: [] } : null,
    remainingAmountOfUpdates: remaining,
  });
  const states = (from: string | null, remaining: number | null, status?: string) => ['4240863', '4240865', '4240868'].map((id) => fboInvoiceState(id, invoice(from, remaining, status)));
  it('ответ кабинета по накладной разбирается', () => {
    expect(fboInvoiceState('4240863', invoice('2026-11-29T06:00:00+05:00', 2))).toMatchObject({ invoiceId: '4240863', status: 'CREATED', remainingUpdates: 2 });
    expect(fboInvoiceState('4240863', invoice('2026-11-29T06:00:00+05:00', 2)).reservation?.from.getTime()).toBe(ms('2026-11-29T06:00:00+05:00'));
    expect(fboInvoiceState('1', { payload: { status: 'CREATED', remainingAmountOfUpdates: 3 } })).toMatchObject({ status: 'CREATED', reservation: null, remainingUpdates: 3 });
  });
  it('слота нет — бронируем; есть — переносим только на день раньше', () => {
    expect(fboDecide(states(null, 3), slotAt('2026-11-29T10:30:00+05:00'), now).action).toBe('book');
    expect(fboDecide(states(null, 3), null, now).action).toBe('wait');
    expect(fboDecide(states('2026-11-29T06:00:00+05:00', 2), slotAt('2026-11-29T10:30:00+05:00'), now).action).toBe('wait');
    expect(fboDecide(states('2026-11-29T06:00:00+05:00', 2), slotAt('2026-11-25T10:30:00+05:00'), now)).toMatchObject({ action: 'move', current: { from: new Date('2026-11-29T06:00:00+05:00') } });
  });
  it('последняя смена слота остаётся владельцу; без числа смен не переносим', () => {
    expect(fboDecide(states('2026-11-29T06:00:00+05:00', 1), slotAt('2026-11-25T10:30:00+05:00'), now)).toMatchObject({ action: 'stop' });
    expect(fboDecide(states('2026-11-29T06:00:00+05:00', 1), slotAt('2026-11-25T10:30:00+05:00'), now).reason).toMatch(/последняя смена/);
    expect(fboDecide(states('2026-11-29T06:00:00+05:00', null), slotAt('2026-11-25T10:30:00+05:00'), now)).toMatchObject({ action: 'wait' });
  });
  it('до слота 48 ч и меньше — перенос со штрафом, не трогаем; накладная ушла из «Создана» — тоже', () => {
    expect(fboDecide(states('2026-11-19T12:00:00+05:00', 2), slotAt('2026-11-19T10:00:00+05:00'), now)).toMatchObject({ action: 'stop' });
    expect(fboDecide(states('2026-11-29T06:00:00+05:00', 2, 'SENT'), slotAt('2026-11-25T10:30:00+05:00'), now)).toMatchObject({ action: 'stop', current: null });
  });
});
