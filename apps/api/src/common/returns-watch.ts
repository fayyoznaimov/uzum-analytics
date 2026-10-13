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

/** Текст для Telegram. Пустая строка — писать нечего, сообщение не отправляем. */
export function formatWatchMessage(input: {
  transitions: TransitionEvent[];
  warehouse: WarehouseEvent[];
  stillStuck: StuckOrder[];
}): string {
  const { transitions, warehouse, stillStuck } = input;
  if (!transitions.length && !warehouse.length) return '';
  const lines: string[] = ['🔁 Зависшие заказы: есть движение'];
  const group = (kind: TransitionEvent['kind']) => transitions.filter((event) => event.kind === kind);
  const returned = group('RETURNED');
  if (returned.length) {
    lines.push('', 'Закрыты возвратом:');
    for (const event of returned) {
      lines.push(`• №${event.number} — ${event.skus.join(', ')}, ${money(event.gross)} не придут (висел ${event.daysStuck} дн.)`);
    }
  }
  const issued = group('ISSUED');
  if (issued.length) {
    lines.push('', 'Наконец выданы:');
    for (const event of issued) {
      lines.push(`• №${event.number} — ${event.skus.join(', ')}, выплата ${money(event.payout)} (висел ${event.daysStuck} дн.)`);
    }
  }
  const moved = group('MOVED');
  if (moved.length) {
    lines.push('', 'Сменили статус:');
    for (const event of moved) lines.push(`• №${event.number} — ${event.from} → ${event.to}`);
  }
  const back = warehouse.filter((event) => event.kind === 'BACK_IN_STOCK');
  if (back.length) {
    lines.push('', 'Товар вернулся на склад и снова в продаже:');
    for (const event of back) lines.push(`• ${event.sellerSku}: +${event.units} шт., доступно ${event.available}`);
  }
  const pendingBack = warehouse.filter((event) => event.kind === 'RETURN_REGISTERED');
  if (pendingBack.length) {
    lines.push('', 'Возврат оформлен, но на склад ещё не принят:');
    for (const event of pendingBack) lines.push(`• ${event.sellerSku}: ${event.units} шт. в пути`);
  }
  const defect = warehouse.filter((event) => event.kind === 'BACK_AS_DEFECT');
  if (defect.length) {
    lines.push('', 'Вернулось браком — в продажу не попадёт:');
    for (const event of defect) lines.push(`• ${event.sellerSku}: ${event.units} шт.`);
  }
  if (stillStuck.length) {
    const sum = stillStuck.reduce((total, row) => total + row.gross, 0);
    const oldest = stillStuck[0];
    lines.push('', `Ещё висят: ${stillStuck.length} заказов на ${money(sum)}. Самый старый — №${oldest.number}`
      + `${oldest.orderedAt ? ` от ${dateLabel(oldest.orderedAt)}` : ''}, ${oldest.daysStuck} дн.`);
  } else {
    lines.push('', 'Зависших заказов больше нет.');
  }
  return lines.join('\n');
}
