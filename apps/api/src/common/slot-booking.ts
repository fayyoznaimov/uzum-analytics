/**
 * Автобронь тайм-слота FBS-поставки: выбор подходящего слота под желаемую дату. Модуль чистый — без сети.
 *
 * Владелец задаёт окно «желаемая дата с … по» (даты Asia/Tashkent, включительно) — как в SellerX: «выберите накладную
 * и дату — дальше мы всё сделаем сами». Из свободных слотов берём самый ранний внутри окна; окно не задано — самый ранний
 * вообще. Слоты в прошлом и без времени начала не подходят.
 */

export type FreeSlot = { id: string; from: Date | null; to: Date | null; capacity: number; raw?: unknown };
export type DesiredWindow = { from: Date | null; to: Date | null };

const TASHKENT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' });
export const tashkentDayKey = (date: Date) => TASHKENT_DAY.format(date);

/** Слот попадает в окно, если его день (по Ташкенту) между днями from…to включительно. */
export function slotInWindow(slot: FreeSlot, window: DesiredWindow): boolean {
  if (!slot.from) return false;
  const day = tashkentDayKey(slot.from);
  if (window.from && day < tashkentDayKey(window.from)) return false;
  if (window.to && day > tashkentDayKey(window.to)) return false;
  return true;
}

/** Самый ранний будущий слот в окне (или вообще, если окно пустое); null — подходящих нет. */
export function pickSlot(slots: FreeSlot[], window: DesiredWindow, now: Date = new Date()): FreeSlot | null {
  const candidates = slots
    .filter((slot) => slot.from && slot.from.getTime() > now.getTime())
    .filter((slot) => slot.capacity === 0 ? false : true)
    .filter((slot) => slotInWindow(slot, window))
    .sort((a, b) => (a.from as Date).getTime() - (b.from as Date).getTime());
  return candidates[0] ?? null;
}

const fmtDate = (date: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
const fmtTime = (date: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(date);

export function formatSlot(slot: FreeSlot): string {
  if (!slot.from) return 'время не указано';
  return `${fmtDate(slot.from)} ${fmtTime(slot.from)}${slot.to ? `–${fmtTime(slot.to)}` : ''}`;
}

export function formatWindow(window: DesiredWindow): string {
  if (!window.from && !window.to) return 'любая дата';
  if (window.from && window.to && tashkentDayKey(window.from) === tashkentDayKey(window.to)) return fmtDate(window.from);
  return `${window.from ? `с ${fmtDate(window.from)}` : ''}${window.from && window.to ? ' ' : ''}${window.to ? `по ${fmtDate(window.to)}` : ''}`;
}

/*
 * FBO: слоты склада Uzum для созданной накладной — только через API кабинета (токен UZUM_INTERNAL), найдено 17.11.2026
 * в бандле seller.uzum.uz (getTimeSlots1 / updateTimeSlot1):
 *   POST api-seller.uzum.uz/api/seller/shop/{shopId}/v2/invoice/time-slot/get  { invoiceIds, poolSource, timeFrom }
 *     → { payload: { timeSlots: [{ timeFrom, timeTo }] } } (миллисекунды; пустой список — «Сейчас нет свободного времени»);
 *   POST …/v2/invoice/time-slot/set  { timeFrom, invoiceIds, stockId, poolSource } — бронь одного слота сразу на
 *     несколько накладных (как «Выбрать время» для отмеченных в списке поставок кабинета).
 * stockId и poolSource берутся из накладной (`stock.id`, `stock.poolSource`; у фулфилмент-центра Ташкента 34 / FULLFILMENT).
 */
export type FboStock = { stockId: number; poolSource: string };
export const FBO_SLOTS_GET_PATH = (shopId: string) => `https://api-seller.uzum.uz/api/seller/shop/${shopId}/v2/invoice/time-slot/get`;
export const FBO_SLOTS_SET_PATH = (shopId: string) => `https://api-seller.uzum.uz/api/seller/shop/${shopId}/v2/invoice/time-slot/set`;

const epoch = (value: unknown): Date | null => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  const date = typeof n === 'number' ? new Date(n) : typeof n === 'string' ? new Date(n) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** Склад и пул накладной из её данных (Supply.raw из OpenAPI или кабинета); null — не указаны. */
export function fboStockOf(raw: unknown): FboStock | null {
  const stock = (raw as any)?.stock;
  const stockId = Number(stock?.id);
  if (!Number.isFinite(stockId) || stockId <= 0) return null;
  return { stockId, poolSource: String(stock?.poolSource || 'FULLFILMENT') };
}

/** Забронированный слот накладной (timeSlotReservation.timeFrom/timeTo в мс); null — слот не выбран. */
export function fboReservation(raw: unknown): { from: Date; to: Date | null } | null {
  const reservation = (raw as any)?.timeSlotReservation;
  const from = epoch(reservation?.timeFrom);
  return from ? { from, to: epoch(reservation?.timeTo) } : null;
}

/**
 * timeFrom — на час вперёд, как у кабинета: время «сейчас» Uzum отклоняет («400 Validation failed», 17.11.2026 —
 * к проверке оно уже в прошлом), а слотов раньше чем через час всё равно не бывает.
 */
export function fboSlotsRequest(invoiceIds: Array<string | number>, stock: FboStock, now: Date = new Date()) {
  return { invoiceIds: invoiceIds.map(Number), poolSource: stock.poolSource, timeFrom: now.getTime() + 60 * 60_000 };
}

/**
 * Ответ time-slot/get → свободные слоты. Вместимость кабинет не сообщает (NaN — «неизвестно», pickSlot такие не
 * отбрасывает). Нераспознанный ответ — ошибка, а не «слотов нет»: иначе смена формата выглядела бы как вечное ожидание.
 */
export function parseFboSlots(body: unknown): FreeSlot[] {
  const rows = (body as any)?.payload?.timeSlots ?? (body as any)?.timeSlots;
  if (!Array.isArray(rows)) throw new Error('Кабинет Uzum вернул тайм-слоты в незнакомом формате');
  return rows
    .map((slot: any) => ({ id: String(slot?.timeFrom ?? ''), from: epoch(slot?.timeFrom), to: epoch(slot?.timeTo), capacity: Number.NaN, raw: slot }))
    .filter((slot) => slot.from);
}

export function fboBookRequest(slot: FreeSlot, invoiceIds: Array<string | number>, stock: FboStock) {
  if (!slot.from) throw new Error('У слота нет времени начала');
  return { timeFrom: slot.from.getTime(), invoiceIds: invoiceIds.map(Number), stockId: stock.stockId, poolSource: stock.poolSource };
}

/**
 * Накладные с одинаковым складом, окном и режимом брони ищут и бронируют слот вместе — один привоз на склад, как
 * множественный выбор в списке поставок кабинета. Ключ группы — склад, пул, окно (дни по Ташкенту) и автобронь.
 */
export function fboGroupKey(stock: FboStock, window: DesiredWindow, autoBook: boolean): string {
  return [stock.stockId, stock.poolSource, window.from ? tashkentDayKey(window.from) : '', window.to ? tashkentDayKey(window.to) : '', autoBook ? 'auto' : 'notify'].join('|');
}
