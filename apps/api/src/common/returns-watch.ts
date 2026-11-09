/**
 * Слежка за зависшими заказами и за возвратом товара на склад.
 *
 * Зависший заказ — заказан давно, но так и не выдан покупателю (state WAITING).
 * Uzum не отдаёт ни ожидаемую дату возврата, ни событие «товар принят складом»:
 * статус переключается задним числом, одним днём и без предупреждения. Поэтому
 * здесь два независимых источника правды:
 *   1) переходы статусов заказов (OrderStatusHistory) — «заказ закрыт возвратом»;
 *   2) снимки складских количеств SKU из кабинета — «штука снова в продаже».
 * Второе нужно потому, что закрытый возврат ещё не означает товар на складе:
 * единица может быть принята как брак или неделями ехать назад.
 *
 * Модуль чистый: правила, арифметика и текст. Сеть, БД и Telegram — в сервисе.
 */

export const STUCK_ORDER_STATE = 'WAITING';
/** Состояния, после которых заказ больше не ждёт выдачи. */
const RETURN_STATES = new Set(['RETURNED', 'CANCELED']);
const ISSUED_STATES = new Set(['PAID']);

const DAY_MS = 86_400_000;
const money = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value))} сум`;
const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export type OrderRow = {
  id: string;
  marketplaceOrderId?: string | null;
  externalId?: string | null;
  state?: string | null;
  orderedAt?: Date | string | null;
  issuedAt?: Date | string | null;
  returnedUnits?: number | null;
  grossRevenue?: unknown;
  payout?: unknown;
  items?: Array<{ sku?: { sellerSku?: string | null } | null; title?: string | null }>;
};

export type StuckOrder = {
  orderId: string;
  number: string;
  orderedAt: Date | null;
  daysStuck: number;
  gross: number;
  payout: number;
  skus: string[];
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function orderNumber(order: OrderRow) {
  return String(order.marketplaceOrderId || order.externalId || order.id);
}

function orderSkus(order: OrderRow) {
  return (order.items || []).map((item) => item?.sku?.sellerSku || item?.title || '—');
}

/**
 * Заказы, которые ждут выдачи дольше порога. Ровно они и есть «зависшие»:
 * деньги по ним не получены, товар лежит в пункте выдачи.
 */
export function pickStuckOrders(orders: OrderRow[], options: { cutoffDays: number; now?: Date }): StuckOrder[] {
  const now = options.now ?? new Date();
  const cutoff = Math.max(0, options.cutoffDays);
  return orders
    .filter((order) => String(order.state || '') === STUCK_ORDER_STATE)
    .filter((order) => num(order.returnedUnits) === 0 && !toDate(order.issuedAt))
    .map((order) => {
      const orderedAt = toDate(order.orderedAt);
      return {
        orderId: order.id,
        number: orderNumber(order),
        orderedAt,
        daysStuck: orderedAt ? Math.floor((now.getTime() - orderedAt.getTime()) / DAY_MS) : 0,
        gross: num(order.grossRevenue),
        payout: num(order.payout),
        skus: orderSkus(order),
      };
    })
    .filter((row) => row.daysStuck >= cutoff)
    .sort((a, b) => b.daysStuck - a.daysStuck);
}

export type TransitionRow = {
  id: string;
  toStatus: string;
  fromStatus?: string | null;
  changedAt: Date | string;
  order: OrderRow;
};

export type TransitionEvent = {
  kind: 'RETURNED' | 'ISSUED' | 'MOVED';
  historyId: string;
  number: string;
  at: Date;
  from: string | null;
  to: string;
  gross: number;
  payout: number;
  skus: string[];
  daysStuck: number;
};

/** Чем закончилось ожидание: возвратом, выдачей или просто другим статусом. */
export function classifyTransition(to: string): TransitionEvent['kind'] {
  const value = String(to || '').toUpperCase();
  if (RETURN_STATES.has(value)) return 'RETURNED';
  if (ISSUED_STATES.has(value)) return 'ISSUED';
  return 'MOVED';
}

/**
 * Сдвиги по заказам, которые до этого висели. Берём только переходы ИЗ ожидания:
 * обычная жизнь свежего заказа (создан → выдан) сюда попадать не должна.
 */
export function pickTransitions(rows: TransitionRow[], options: { cutoffDays: number; now?: Date }): TransitionEvent[] {
  const now = options.now ?? new Date();
  const cutoff = Math.max(0, options.cutoffDays);
  const events: TransitionEvent[] = [];
  for (const row of rows) {
    if (String(row.fromStatus || '') !== STUCK_ORDER_STATE) continue;
    const at = toDate(row.changedAt);
    if (!at) continue;
    const orderedAt = toDate(row.order?.orderedAt);
    const daysStuck = orderedAt ? Math.floor((at.getTime() - orderedAt.getTime()) / DAY_MS) : 0;
    if (daysStuck < cutoff) continue;
    events.push({
      kind: classifyTransition(row.toStatus),
      historyId: row.id,
      number: orderNumber(row.order),
      at,
      from: row.fromStatus ?? null,
      to: String(row.toStatus),
      gross: num(row.order?.grossRevenue),
      payout: num(row.order?.payout),
      skus: orderSkus(row.order),
      daysStuck,
    });
  }
  return events.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export type WarehouseRow = {
  skuId: string;
  sellerSku: string;
  available: number;
  returnedTotal: number;
  defectedTotal: number;
};

export type WarehouseEvent = {
  kind: 'BACK_IN_STOCK' | 'BACK_AS_DEFECT' | 'RETURN_REGISTERED';
  skuId: string;
  sellerSku: string;
  units: number;
  available: number;
  capturedKey: string;
};

/**
 * Что изменилось на складе по сравнению с прошлым снимком.
 * Возврат, доехавший до склада, виден как одновременный рост «возвращено» и
 * «доступно». Если выросло только «возвращено» — единица ещё в пути или на
 * приёмке. Рост «брака» означает, что товар назад в продажу уже не попадёт.
 */
export function warehouseEvents(
  before: Map<string, WarehouseRow> | Record<string, WarehouseRow>,
  current: WarehouseRow[],
  capturedKey = '',
): WarehouseEvent[] {
  const previous = before instanceof Map ? before : new Map(Object.entries(before));
  const events: WarehouseEvent[] = [];
  for (const row of current) {
    const prev = previous.get(row.skuId);
    if (!prev) continue;
    const returned = row.returnedTotal - prev.returnedTotal;
    const defected = row.defectedTotal - prev.defectedTotal;
    const available = row.available - prev.available;
    const base = { skuId: row.skuId, sellerSku: row.sellerSku, available: row.available, capturedKey };
    if (defected > 0) events.push({ ...base, kind: 'BACK_AS_DEFECT', units: defected });
    if (returned <= 0) continue;
    if (available > 0) events.push({ ...base, kind: 'BACK_IN_STOCK', units: Math.min(returned, available) });
    else events.push({ ...base, kind: 'RETURN_REGISTERED', units: returned });
  }
  return events;
}

const dateLabel = (date: Date) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Tashkent' }).format(date);

const ordersWord = (count: number) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  return mod10 === 1 && mod100 !== 11 ? 'заказ' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'заказа' : 'заказов';
};

/**
 * Событие в журнале NotificationLog. С 09.11.2026 (владелец: «про зависшие не надо каждый раз напоминать, раз в неделю»)
 * слежка каждый час только копит события, а в Telegram раз в неделю уходит одна сводка (formatWatchDigest).
 */
export const STUCK_MOVED_LOG = 'STUCK_ORDER_MOVED';
export const RETURN_STOCK_LOG = 'RETURN_IN_STOCK';
export const WATCH_DIGEST_LOG = 'RETURNS_WATCH_DIGEST';

export const transitionPayload = (event: TransitionEvent) => ({ kind: event.kind, number: event.number, from: event.from, to: event.to, daysStuck: event.daysStuck, gross: event.gross, payout: event.payout, skus: event.skus });
export const warehousePayload = (event: WarehouseEvent) => ({ sellerSku: event.sellerSku, kind: event.kind, units: event.units, available: event.available });

export type DigestTransition = { kind: TransitionEvent['kind']; number: string; gross: number; payout: number };
export type DigestWarehouse = { kind: WarehouseEvent['kind']; sellerSku: string; units: number };

/** Записи журнала → события сводки. Старые записи (до 09.11.2026) без kind и payout — kind по статусу. */
export function digestEvents(logs: Array<{ type: string; payload: unknown }>): { transitions: DigestTransition[]; warehouse: DigestWarehouse[] } {
  const transitions: DigestTransition[] = [];
  const warehouse: DigestWarehouse[] = [];
  for (const log of logs) {
    const p = (log.payload && typeof log.payload === 'object' ? log.payload : {}) as Record<string, unknown>;
    if (log.type === STUCK_MOVED_LOG) {
      const kind = ['RETURNED', 'ISSUED', 'MOVED'].includes(String(p.kind)) ? (p.kind as TransitionEvent['kind']) : classifyTransition(String(p.to ?? ''));
      transitions.push({ kind, number: String(p.number ?? '—'), gross: num(p.gross), payout: num(p.payout) });
    } else if (log.type === RETURN_STOCK_LOG && ['BACK_IN_STOCK', 'BACK_AS_DEFECT', 'RETURN_REGISTERED'].includes(String(p.kind))) {
      warehouse.push({ kind: p.kind as WarehouseEvent['kind'], sellerSku: String(p.sellerSku ?? '—'), units: num(p.units) });
    }
  }
  return { transitions, warehouse };
}

/**
 * Недельная сводка: сколько висит сейчас и что случилось за неделю — итогами, без перечня каждого события.
 * Возвраты «оформлен, на склад ещё не принят» в сводку не идут: через час-неделю те же штуки приходят «на склад» или «браком».
 * Пустая строка — писать нечего (ничего не висит и движения не было).
 */
export function formatWatchDigest(input: { transitions: DigestTransition[]; warehouse: DigestWarehouse[]; stillStuck: StuckOrder[]; cutoffDays: number; days: number }): string {
  const { transitions, warehouse, stillStuck, cutoffDays, days } = input;
  const lines: string[] = [];
  const of = (kind: DigestTransition['kind']) => transitions.filter((event) => event.kind === kind);
  const returned = of('RETURNED');
  if (returned.length) lines.push(`• закрыты возвратом: ${returned.length} ${ordersWord(returned.length)}, ${money(returned.reduce((sum, event) => sum + event.gross, 0))} не придут`);
  const issued = of('ISSUED');
  if (issued.length) lines.push(`• наконец выданы: ${issued.length} ${ordersWord(issued.length)}, выплата ${money(issued.reduce((sum, event) => sum + event.payout, 0))}`);
  const moved = of('MOVED');
  if (moved.length) lines.push(`• сменили статус: ${moved.length} ${ordersWord(moved.length)}`);
  const units = (kind: DigestWarehouse['kind']) => warehouse.filter((event) => event.kind === kind).reduce((sum, event) => sum + event.units, 0);
  const back = units('BACK_IN_STOCK');
  if (back) lines.push(`• вернулись на склад и снова в продаже: ${back} шт.`);
  const defects = warehouse.filter((event) => event.kind === 'BACK_AS_DEFECT');
  if (defects.length) {
    const bySku = new Map<string, number>();
    for (const event of defects) bySku.set(event.sellerSku, (bySku.get(event.sellerSku) ?? 0) + event.units);
    lines.push(`• вернулись браком, в продажу не попадут: ${units('BACK_AS_DEFECT')} шт. (${[...bySku].map(([sku, count]) => `${sku}${count > 1 ? ` ×${count}` : ''}`).join(', ')})`);
  }
  if (!stillStuck.length && !lines.length) return '';
  const head = ['🔁 Зависшие заказы — сводка за неделю'];
  if (stillStuck.length) {
    const sum = stillStuck.reduce((total, row) => total + row.gross, 0);
    head.push(`Висят без выдачи дольше ${cutoffDays} дн.: ${stillStuck.length} ${ordersWord(stillStuck.length)} на ${money(sum)}.`);
    head.push(`Самые старые: ${stillStuck.slice(0, 3).map((row) => `№${row.number}${row.orderedAt ? ` от ${dateLabel(row.orderedAt)}` : ''} (${row.daysStuck} дн.)`).join(', ')}`);
  } else {
    head.push('Зависших заказов нет.');
  }
  return [...head, '', lines.length ? `За ${days} дн.:` : `За ${days} дн. движения не было.`, ...lines].join('\n');
}
