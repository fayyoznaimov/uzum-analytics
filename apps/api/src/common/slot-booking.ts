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
