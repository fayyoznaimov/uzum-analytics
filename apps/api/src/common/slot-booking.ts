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

/**
 * Запас до привоза: слот берём не раньше чем через столько часов от момента брони — владельцу нужно время собрать и
 * отвезти товар (17.11.2026: «как минимум за 2 дня»). SUPPLY_FBO_MIN_LEAD_HOURS, по умолчанию 48.
 */
export const FBO_DEFAULT_LEAD_HOURS = 48;
export function fboLeadHours(value: string | undefined): number {
  const hours = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : FBO_DEFAULT_LEAD_HOURS;
}
/** Самое раннее допустимое начало слота — передаётся в pickSlot вместо «сейчас». */
export function fboEarliestStart(now: Date, leadHours: number): Date {
  return new Date(now.getTime() + leadHours * 60 * 60_000);
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

/*
 * Проверка слотов из Chrome владельца (17.11.2026: сервер снова за Cloudflare, а слот нужен «как только появится»):
 * расширение extensions/uzum-monitor берёт у сервера задания (группы накладных), спрашивает слоты у кабинета своим
 * токеном кабинета (он не покидает браузер), само бронирует по тому же правилу — самый ранний слот в окне и не ближе
 * запаса — и присылает отчёт. Пока расширение отчитывается без ошибок, серверный бот кабинет не трогает.
 */
export type FboExtensionTask = {
  key: string; shopId: string; invoiceIds: string[]; labels: string;
  stockId: number; poolSource: string; windowFrom: string | null; windowTo: string | null; autoBook: boolean;
  /** Самый ранний уже забронированный слот группы по данным сервера (мс) — расширение ищет только день раньше. */
  reservedFrom: number | null;
};

export function fboExtensionTask(key: string, shopId: string, invoiceIds: string[], labels: string, stock: FboStock, window: DesiredWindow, autoBook: boolean, reservedFrom: Date | null = null): FboExtensionTask {
  return {
    key, shopId, invoiceIds, labels, stockId: stock.stockId, poolSource: stock.poolSource,
    windowFrom: window.from ? tashkentDayKey(window.from) : null, windowTo: window.to ? tashkentDayKey(window.to) : null, autoBook,
    reservedFrom: reservedFrom ? reservedFrom.getTime() : null,
  };
}

/** Сколько отчёт расширения считается свежим: дольше — сервер снова проверяет слоты сам. */
export const FBO_EXTENSION_FRESH_MS = 10 * 60_000;
export function extensionCovers(lastOkAt: number | null, now: number): boolean {
  return lastOkAt !== null && now - lastOkAt >= 0 && now - lastOkAt < FBO_EXTENSION_FRESH_MS;
}

export type FboExtensionResult = {
  invoiceIds: string[]; checkedAt: Date; error: string | null; slotsCount: number | null;
  matched: FreeSlot | null; booked: boolean; bookError: string | null; reserved: { from: Date; to: Date | null } | null;
  /** Перенос на более ранний день: какой слот был до него. */
  moved: boolean; previous: { from: Date; to: Date | null } | null;
  /** Почему бот больше не трогает слот этих накладных (последняя смена, меньше 48 ч, статус) — наблюдение выключается. */
  stop: string | null;
  /** Брони накладных по кабинету на момент проверки. */
  reservations: Array<{ invoiceId: string; from: Date; to: Date | null }>;
};

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;

/**
 * Отчёт расширения → проверенные результаты. Чужие и битые строки отбрасываются (номер накладной — только цифры),
 * «забронировано» без слота не принимается, время проверки вне последних суток заменяется на «сейчас».
 */
export function parseFboExtensionReport(body: unknown, now: Date = new Date()): FboExtensionResult[] {
  const rows = (body as any)?.results;
  if (!Array.isArray(rows)) return [];
  const result: FboExtensionResult[] = [];
  for (const row of rows.slice(0, 20)) {
    const ids = Array.isArray(row?.invoiceIds) ? row.invoiceIds.map((id: unknown) => String(id ?? '').trim()) : [];
    if (!ids.length || ids.length > 20 || ids.some((id: string) => !/^\d{1,15}$/.test(id))) continue;
    const checked = epoch(row?.checkedAt);
    const fresh = checked && checked.getTime() <= now.getTime() + 5 * 60_000 && checked.getTime() >= now.getTime() - 24 * 60 * 60_000;
    const matchedFrom = epoch(row?.matched?.timeFrom);
    const matched: FreeSlot | null = matchedFrom ? { id: String(matchedFrom.getTime()), from: matchedFrom, to: epoch(row?.matched?.timeTo), capacity: Number.NaN } : null;
    const reservedFrom = epoch(row?.reserved?.timeFrom);
    const slotsCount = Number(row?.slots);
    result.push({
      invoiceIds: [...new Set<string>(ids)],
      checkedAt: fresh ? checked : now,
      error: text(row?.error),
      slotsCount: Number.isFinite(slotsCount) && slotsCount >= 0 ? slotsCount : null,
      matched,
      booked: Boolean(matched && row?.booked === true),
      bookError: matched ? text(row?.bookError) : null,
      reserved: reservedFrom ? { from: reservedFrom, to: epoch(row?.reserved?.timeTo) } : null,
      moved: Boolean(matched && row?.booked === true && row?.moved === true),
      previous: epoch(row?.previous?.timeFrom) ? { from: epoch(row?.previous?.timeFrom) as Date, to: epoch(row?.previous?.timeTo) } : null,
      stop: text(row?.stop),
      reservations: (Array.isArray(row?.reservations) ? row.reservations : [])
        .map((item: any) => ({ invoiceId: String(item?.invoiceId ?? ''), from: epoch(item?.timeFrom), to: epoch(item?.timeTo) }))
        .filter((item: any) => ids.includes(item.invoiceId) && item.from)
        .slice(0, 20) as Array<{ invoiceId: string; from: Date; to: Date | null }>,
    });
  }
  return result;
}

/*
 * Перенос на более ранний слот (владелец 17.11.2026: слоты вышли, он взял 29.11 вручную — «если появятся раньше,
 * нужно будет перенести»). Автобронь FBO после брони не выключается: каждый прогон смотрит, нет ли слота на день
 * раньше текущего (и не ближе запаса в 2 дня), и переносит все накладные группы туда одним запросом time-slot/set.
 * Ограничения кабинета: у накладной 3 смены слота (remainingAmountOfUpdates, первая бронь тоже считается), смена
 * позже чем за 48 ч до слота — штраф INVOICE_LATE_TIME_SLOT_UPDATE (порог по умолчанию из бандла seller.uzum.uz).
 * Поэтому бот никогда не тратит последнюю смену (она остаётся владельцу) и не трогает слот, до которого ≤ 48 ч.
 */
export const FBO_INVOICE_PATH = (shopId: string, invoiceId: string) => `https://api-seller.uzum.uz/api/seller/shop/${shopId}/invoice/${invoiceId}`;
export const FBO_LATE_UPDATE_HOURS = 48;
export const FBO_KEEP_UPDATES = 1;

export type FboReservation = { from: Date; to: Date | null };
export type FboInvoiceState = { invoiceId: string; status: string | null; reservation: FboReservation | null; remainingUpdates: number | null };

/** Ответ кабинета GET …/invoice/{id} → статус, бронь и сколько смен слота осталось. */
export function fboInvoiceState(invoiceId: string, body: unknown): FboInvoiceState {
  const wrapped = (body as any)?.payload;
  const invoice: any = wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped) ? wrapped : body;
  const status = invoice?.invoiceStatus?.value ?? (typeof invoice?.invoiceStatus === 'string' ? invoice.invoiceStatus : null) ?? (typeof invoice?.status === 'string' ? invoice.status : invoice?.status?.value) ?? null;
  const remaining = invoice?.remainingAmountOfUpdates;
  return {
    invoiceId: String(invoiceId),
    status: status ? String(status) : null,
    reservation: fboReservation(invoice),
    remainingUpdates: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null,
  };
}

export function fboEarliestReservation(list: Array<FboReservation | null>): FboReservation | null {
  return list.filter((item): item is FboReservation => Boolean(item)).sort((a, b) => a.from.getTime() - b.from.getTime())[0] ?? null;
}

/** Переносим только на более ранний день (по Ташкенту): сдвиг на пару часов в тот же день не стоит смены слота. */
export function fboEarlierDay(candidate: Date, current: Date): boolean {
  return tashkentDayKey(candidate) < tashkentDayKey(current);
}

export type FboDecision = { action: 'book' | 'move' | 'wait' | 'stop'; reason: string | null; current: FboReservation | null };

/** Что делать с группой накладных, если найден слот candidate (уже с учётом окна и запаса в 2 дня). */
export function fboDecide(states: FboInvoiceState[], candidate: FreeSlot | null, now: Date): FboDecision {
  const gone = states.find((state) => state.status && state.status !== 'CREATED');
  if (gone) return { action: 'stop', reason: `Накладная ${gone.invoiceId} уже не в статусе «Создана»`, current: null };
  const current = fboEarliestReservation(states.map((state) => state.reservation));
  if (!current) return { action: candidate ? 'book' : 'wait', reason: null, current: null };
  const slot = formatSlot({ id: '', from: current.from, to: current.to, capacity: 0 });
  if (current.from.getTime() - now.getTime() <= FBO_LATE_UPDATE_HOURS * 60 * 60_000) return { action: 'stop', reason: `Слот ${slot}: до него меньше 48 ч, перенос был бы со штрафом — бот больше не переносит`, current };
  const remaining = states.map((state) => state.remainingUpdates).filter((value): value is number => value !== null);
  if (remaining.length && Math.min(...remaining) <= FBO_KEEP_UPDATES) return { action: 'stop', reason: `Слот ${slot}: осталась последняя смена слота — она за вами, бот больше не переносит`, current };
  if (!candidate?.from || !fboEarlierDay(candidate.from, current.from)) return { action: 'wait', reason: null, current };
  if (remaining.length < states.length) return { action: 'wait', reason: 'Кабинет не сообщил, сколько смен слота осталось — не переносим', current };
  return { action: 'move', reason: null, current };
}
