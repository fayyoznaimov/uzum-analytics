import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { FreeSlot, fboDecide, fboEarliestStart, fboInvoiceState, parseFboSlots, pickSlot } from '../slot-booking';

// Логика выбора слота в Chrome-расширении (extensions/uzum-monitor/slot-logic.js) — простой JS без сборки; здесь
// проверяем, что она выбирает тот же слот, что и сервер.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const logic = require(join(__dirname, '../../../../../extensions/uzum-monitor/slot-logic.js'));

const at = (iso: string) => ({ timeFrom: Date.parse(iso), timeTo: Date.parse(iso) + 7_200_000 });
const body = { payload: { timeSlots: [at('2026-11-18T10:00:00+05:00'), at('2026-11-19T11:00:00+05:00'), at('2026-11-19T13:00:00+05:00'), at('2026-11-28T00:30:00+05:00'), at('2026-12-02T09:00:00+05:00')] } };
const booking = Date.parse('2026-11-17T12:00:00+05:00');

describe('выбор слота в расширении = выбор на сервере', () => {
  const cases: Array<{ leadHours: number; windowFrom: string | null; windowTo: string | null }> = [
    { leadHours: 48, windowFrom: null, windowTo: null },
    { leadHours: 0, windowFrom: null, windowTo: null },
    { leadHours: 48, windowFrom: '2026-11-28', windowTo: '2026-11-30' },
    { leadHours: 48, windowFrom: null, windowTo: '2026-11-18' },
  ];
  for (const task of cases) {
    it(`запас ${task.leadHours} ч, окно ${task.windowFrom ?? '…'}–${task.windowTo ?? '…'}`, () => {
      const server = pickSlot(parseFboSlots(body), {
        from: task.windowFrom ? new Date(`${task.windowFrom}T00:00:00+05:00`) : null,
        to: task.windowTo ? new Date(`${task.windowTo}T23:59:59+05:00`) : null,
      }, fboEarliestStart(new Date(booking), task.leadHours));
      const ext = logic.pickSlot(logic.parseSlots(body), task, booking);
      expect(ext ? ext.timeFrom : null).toBe(server ? server.from!.getTime() : null);
    });
  }
  it('день слота — по Ташкенту: 28.11 00:30 по Ташкенту это ещё 27.11 по UTC', () => {
    expect(logic.dayKey(Date.parse('2026-11-28T00:30:00+05:00'))).toBe('2026-11-28');
  });
  it('незнакомый ответ — ошибка; бронь накладной читается из timeSlotReservation', () => {
    expect(() => logic.parseSlots({ payload: {} })).toThrow(/незнакомом формате/);
    expect(logic.reservationOf({ timeSlotReservation: null })).toBeNull();
    expect(logic.reservationOf({ timeSlotReservation: { timeFrom: 1798779600000, timeTo: 1798822800000 } })).toEqual({ timeFrom: 1798779600000, timeTo: 1798822800000 });
    expect(logic.formatSlot({ timeFrom: Date.parse('2027-01-01T09:00:00+05:00'), timeTo: Date.parse('2027-01-01T21:00:00+05:00') })).toBe('01.01.2027 09:00–21:00');
  });
});

describe('перенос в расширении = перенос на сервере', () => {
  const now = Date.parse('2026-11-17T13:00:00+05:00');
  const invoice = (from: string | null, remaining: number | null, status = 'CREATED') => ({
    invoiceStatus: { value: status }, remainingAmountOfUpdates: remaining,
    timeSlotReservation: from ? { timeFrom: Date.parse(from), timeTo: Date.parse(from) + 5_400_000 } : null,
  });
  const cases: Array<{ name: string; from: string | null; remaining: number | null; status?: string; slot: string | null }> = [
    { name: 'первая бронь', from: null, remaining: 3, slot: '2026-11-29T10:30:00+05:00' },
    { name: 'тот же день — ждём', from: '2026-11-29T06:00:00+05:00', remaining: 2, slot: '2026-11-29T10:30:00+05:00' },
    { name: 'день раньше — переносим', from: '2026-11-29T06:00:00+05:00', remaining: 2, slot: '2026-11-25T10:30:00+05:00' },
    { name: 'последняя смена', from: '2026-11-29T06:00:00+05:00', remaining: 1, slot: '2026-11-25T10:30:00+05:00' },
    { name: 'число смен неизвестно', from: '2026-11-29T06:00:00+05:00', remaining: null, slot: '2026-11-25T10:30:00+05:00' },
    { name: 'меньше 48 ч до слота', from: '2026-11-19T12:00:00+05:00', remaining: 2, slot: '2026-11-19T10:00:00+05:00' },
    { name: 'накладная отправлена', from: '2026-11-29T06:00:00+05:00', remaining: 2, status: 'SENT', slot: '2026-11-25T10:30:00+05:00' },
    { name: 'слотов нет', from: '2026-11-29T06:00:00+05:00', remaining: 2, slot: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const ids = ['4240863', '4240865'];
      const serverSlot: FreeSlot | null = c.slot ? { id: '', from: new Date(c.slot), to: null, capacity: Number.NaN } : null;
      const server = fboDecide(ids.map((id) => fboInvoiceState(id, invoice(c.from, c.remaining, c.status))), serverSlot, new Date(now));
      const ext = logic.decide(ids.map((id: string) => logic.invoiceState(id, invoice(c.from, c.remaining, c.status))), c.slot ? { timeFrom: Date.parse(c.slot), timeTo: null } : null, now, { lateUpdateHours: 48, keepUpdates: 1 });
      expect(ext.action).toBe(server.action);
      expect(ext.reason).toBe(server.reason);
    });
  }
});
