// Выбор тайм-слота FBO в расширении — то же правило, что у сервера (apps/api/src/common/slot-booking.ts):
// самый ранний слот, который начинается не раньше чем через leadHours часов и чей день (по Ташкенту) попадает
// в окно windowFrom…windowTo (ГГГГ-ММ-ДД, включительно; пусто — любая дата). Без сети и chrome.* — проверяется
// тестом apps/api/src/common/__tests__/extension-slot-logic.spec.ts.

(function (root) {
  const TASHKENT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' });

  function dayKey(ms) {
    return TASHKENT_DAY.format(new Date(ms));
  }

  function toMs(value) {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  }

  // Ответ time-slot/get → [{ timeFrom, timeTo }] в мс; незнакомый формат — ошибка, а не «слотов нет».
  function parseSlots(body) {
    const rows = body && body.payload && Array.isArray(body.payload.timeSlots) ? body.payload.timeSlots : body && Array.isArray(body.timeSlots) ? body.timeSlots : null;
    if (!rows) throw new Error('кабинет вернул тайм-слоты в незнакомом формате');
    const slots = [];
    for (const row of rows) {
      const timeFrom = toMs(row && row.timeFrom);
      if (timeFrom) slots.push({ timeFrom, timeTo: toMs(row && row.timeTo) });
    }
    return slots;
  }

  function pickSlot(slots, task, nowMs) {
    const lead = Number(task && task.leadHours);
    const earliest = nowMs + (Number.isFinite(lead) && lead >= 0 ? lead : 48) * 3600000;
    const from = task && task.windowFrom ? String(task.windowFrom) : null;
    const to = task && task.windowTo ? String(task.windowTo) : null;
    const candidates = slots
      .filter((slot) => slot.timeFrom > earliest)
      .filter((slot) => {
        const day = dayKey(slot.timeFrom);
        return (!from || day >= from) && (!to || day <= to);
      })
      .sort((a, b) => a.timeFrom - b.timeFrom);
    return candidates[0] || null;
  }

  // Слот, уже забронированный за накладной (GET …/invoice/{id} → timeSlotReservation), или null.
  function reservationOf(invoice) {
    const reservation = invoice && (invoice.timeSlotReservation || (invoice.payload && invoice.payload.timeSlotReservation));
    const timeFrom = toMs(reservation && reservation.timeFrom);
    return timeFrom ? { timeFrom, timeTo: toMs(reservation.timeTo) } : null;
  }

  // GET …/invoice/{id} → статус, бронь и сколько смен слота осталось (как fboInvoiceState на сервере).
  function invoiceState(invoiceId, body) {
    const invoice = body && body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : body;
    const st = invoice && invoice.invoiceStatus;
    const status = (st && typeof st === 'object' ? st.value : st) || (invoice && (typeof invoice.status === 'string' ? invoice.status : invoice.status && invoice.status.value)) || null;
    const remaining = invoice && invoice.remainingAmountOfUpdates;
    return {
      invoiceId: String(invoiceId),
      status: status ? String(status) : null,
      reservation: reservationOf(invoice),
      remainingUpdates: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null,
    };
  }

  function earlierDay(candidateMs, currentMs) {
    return dayKey(candidateMs) < dayKey(currentMs);
  }

  // Бронь / перенос на день раньше / ждать / больше не трогать — то же правило, что fboDecide на сервере:
  // последняя смена слота остаётся владельцу, слот ближе lateUpdateHours (48 ч) не переносим — штраф.
  function decide(states, candidate, nowMs, options) {
    const lateHours = options && Number.isFinite(Number(options.lateUpdateHours)) ? Number(options.lateUpdateHours) : 48;
    const keep = options && Number.isFinite(Number(options.keepUpdates)) ? Number(options.keepUpdates) : 1;
    const gone = states.find((s) => s.status && s.status !== 'CREATED');
    if (gone) return { action: 'stop', reason: `Накладная ${gone.invoiceId} уже не в статусе «Создана»`, current: null };
    const reserved = states.map((s) => s.reservation).filter(Boolean).sort((a, b) => a.timeFrom - b.timeFrom);
    const current = reserved[0] || null;
    if (!current) return { action: candidate ? 'book' : 'wait', reason: null, current: null };
    if (current.timeFrom - nowMs <= lateHours * 3600000) return { action: 'stop', reason: `Слот ${formatSlot(current)}: до него меньше ${lateHours} ч, перенос был бы со штрафом — бот больше не переносит`, current };
    const remaining = states.map((s) => s.remainingUpdates).filter((n) => n !== null);
    if (remaining.length && Math.min(...remaining) <= keep) return { action: 'stop', reason: `Слот ${formatSlot(current)}: осталась последняя смена слота — она за вами, бот больше не переносит`, current };
    if (!candidate || !earlierDay(candidate.timeFrom, current.timeFrom)) return { action: 'wait', reason: null, current };
    if (remaining.length < states.length) return { action: 'wait', reason: 'Кабинет не сообщил, сколько смен слота осталось — не переносим', current };
    return { action: 'move', reason: null, current };
  }

  function formatSlot(slot) {
    const date = new Date(slot.timeFrom);
    const day = date.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' });
    return `${day} ${time(slot.timeFrom)}${slot.timeTo ? `–${time(slot.timeTo)}` : ''}`;
  }

  const api = { dayKey, parseSlots, pickSlot, reservationOf, invoiceState, earlierDay, decide, formatSlot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SlotLogic = api;
})(typeof self !== 'undefined' ? self : this);
