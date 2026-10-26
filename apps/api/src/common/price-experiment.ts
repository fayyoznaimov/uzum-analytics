/**
 * Журнал ценовых экспериментов: каждое реальное изменение цены через 7 дней
 * сравнивается «до/после» по воронке Uzum (показы → открытия → корзина →
 * заказы) с контрольной группой — другими SKU того же товара, у которых цена
 * в эти дни не менялась. Нужен, чтобы решения по ценам опирались на то, что
 * реально сработало в этом магазине, а не на общие правила.
 *
 * Разбор 04.10.2026 показал, почему контроль обязателен: снижение HAVANA 29.09
 * удвоило открытия сниженных SKU, но ровно на столько же уменьшило открытия
 * остальных цветов — по товару в целом прироста не было (каннибализация).
 *
 * С 09.10.2026 воронки Uzum нет (куб SellerReportProductFunnelSku пропал из аналитики),
 * поэтому заказы берутся из учёта магазина (ordersByWindow — штуки совпадают с новым
 * кубом Sales один в один). Вердикт считается только по заказам; показы, открытия и
 * корзина в итогах — 0, «открытия карточки» у внешних кампаний — «—».
 */

export type FunnelTotals = { impressions: number; views: number; carts: number; orders: number; days: number };

/** Позиция заказа из учёта магазина: день заказа (Ташкент) и штуки по SKU и товару (id Uzum). */
export type ExperimentOrderItem = { orderedAt: Date; skuId: string | null; productId: string | null; quantity: number };

export type WindowTotals = Map<string, Map<'before' | 'after', FunnelTotals>>;

const tashkentDayKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(date);

/**
 * Заказанные штуки по SKU или товару в окнах «до» (from … split−1) и «после» (split … to).
 * skipSplitDay — день изменения цены: цена в нём была и старой, и новой, в окна он не входит.
 */
export function ordersByWindow(
  items: ExperimentOrderItem[],
  opts: { key: 'sku' | 'product'; from: string; to: string; split: string; skipSplitDay: boolean; days: number },
): WindowTotals {
  const result: WindowTotals = new Map();
  for (const item of items) {
    const id = opts.key === 'sku' ? item.skuId : item.productId;
    if (!id || !(item.quantity > 0)) continue;
    const day = tashkentDayKey(item.orderedAt);
    if (day < opts.from || day > opts.to || (opts.skipSplitDay && day === opts.split)) continue;
    const window = day < opts.split ? 'before' : 'after';
    const byWindow = result.get(id) ?? new Map<'before' | 'after', FunnelTotals>();
    const totals = byWindow.get(window) ?? { impressions: 0, views: 0, carts: 0, orders: 0, days: opts.days };
    totals.orders += item.quantity;
    byWindow.set(window, totals);
    result.set(id, byWindow);
  }
  return result;
}

/**
 * Дни, по которым спрос не оценить, — окна экспериментов, которые их задевают, получают «мало данных»
 * и в опыт магазина не идут. По умолчанию 14–21.10.2026: ~42 шт. самовыкупа 14–20.10 (владелец, 21.10)
 * и ручное снижение цен на всех карточках вечером 20.10 (не через PriceChange, контроль его не видит).
 * PRICE_EXPERIMENT_EXCLUDE_DAYS — свои диапазоны «ГГГГ-ММ-ДД..ГГГГ-ММ-ДД» через запятую, «off» — без исключений.
 */
export const EXCLUDED_DAYS_DEFAULT = '2026-10-14..2026-10-21';
export type DayRange = { from: string; to: string };

export function parseExcludedDays(value: string | undefined): DayRange[] {
  const raw = value === undefined ? EXCLUDED_DAYS_DEFAULT : value.trim();
  if (!raw || raw.toLowerCase() === 'off') return [];
  const day = /^\d{4}-\d{2}-\d{2}$/;
  return raw.split(',').map((part) => part.trim().split('..').map((item) => item.trim())).flatMap(([from, to = from]) => {
    if (!day.test(from) || !day.test(to)) return [];
    return [from <= to ? { from, to } : { from: to, to: from }];
  });
}

export function overlappingRange(from: string, to: string, ranges: DayRange[]): DayRange | null {
  return ranges.find((range) => from <= range.to && to >= range.from) ?? null;
}

const rangeLabel = (range: DayRange) => {
  const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return range.from === range.to ? short(range.from) : `${short(range.from)}–${short(range.to)}`;
};
const excludedNote = (range: DayRange) => `окно задевает исключённые дни ${rangeLabel(range)} (самовыкупы, ручная смена цен) — спрос не оценить`;

export function excludedExperiment(priceChangePercent: number, range: DayRange): ExperimentResult {
  return { verdict: 'INSUFFICIENT', ordersChangePercent: null, controlOrdersChangePercent: null, productOrdersChangePercent: null, priceChangePercent, note: excludedNote(range) };
}

export function excludedMarketing(range: DayRange): MarketingResult {
  return { verdict: 'INSUFFICIENT', ordersChangePercent: null, controlOrdersChangePercent: null, liftPercent: null, viewsChangePercent: null, note: excludedNote(range) };
}

/** Итоги в Telegram кусками до 3900 символов: строк экспериментов после простоя воронки может быть много. */
export function experimentReport(lines: string[], learned: string | null): string[] {
  const all = ['📊 Ценовые эксперименты: итоги через 7 дней', '', ...lines, ...(learned ? ['', `Опыт магазина за 90 дней: ${learned}`] : [])];
  const chunks: string[] = [];
  let current = '';
  for (const text of all) {
    const line = text.length > 3900 ? `${text.slice(0, 3899)}…` : text;
    if (current && current.length + line.length + 1 > 3900) { chunks.push(current); current = line; } else current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export type ExperimentVerdict = 'HELPED' | 'NO_EFFECT' | 'HURT' | 'CANNIBALIZED' | 'INSUFFICIENT';

export type ExperimentResult = {
  verdict: ExperimentVerdict;
  /** % изменения заказов в день у изменённых SKU. */
  ordersChangePercent: number | null;
  /** % изменения заказов в день у контроля (те же товары, цена не менялась). */
  controlOrdersChangePercent: number | null;
  /** % изменения заказов в день по товару целиком (изменённые + контроль). */
  productOrdersChangePercent: number | null;
  /** Средний сдвиг цены, %. */
  priceChangePercent: number;
  note: string;
};

export const EXPERIMENT_DEFAULTS = {
  /** Меньше заказов в окне «до» и «после» вместе — выводы не делаем. */
  minOrders: 10,
  /** Изменение по товару в пределах ±этого % считаем «эффекта нет». */
  noEffectPercent: 15,
};

const perDay = (t: FunnelTotals, key: keyof Omit<FunnelTotals, 'days'>) => (t.days > 0 ? t[key] / t.days : 0);
const change = (before: number, after: number) => (before > 0 ? (after - before) / before * 100 : null);
const sum = (a: FunnelTotals, b: FunnelTotals): FunnelTotals => ({
  impressions: a.impressions + b.impressions, views: a.views + b.views, carts: a.carts + b.carts, orders: a.orders + b.orders, days: Math.max(a.days, b.days),
});
const pct = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${Math.round(value)}%`);

/**
 * uncontrolledSkus — сколько других SKU товара с заказами в окне не годятся в контроль (их цена тоже
 * менялась). Без контроля при таких SKU «товар целиком» — на деле только изменённая часть, и
 * перетягивание с других цветов не видно: HAVANA 29.09 (−4,5% на 12 SKU) без этого правила вышла
 * бы «помогло» +144%, хотя разбор 04.10 показал каннибализацию (базовая цена 28.09 менялась у всех 36 SKU).
 */
export function evaluateExperiment(
  input: { changed: { before: FunnelTotals; after: FunnelTotals }; control: { before: FunnelTotals; after: FunnelTotals } | null; priceChangePercent: number; uncontrolledSkus?: number },
  cfg = EXPERIMENT_DEFAULTS,
): ExperimentResult {
  const { changed, control, priceChangePercent } = input;
  const ordersChangePercent = change(perDay(changed.before, 'orders'), perDay(changed.after, 'orders'));
  const controlOrdersChangePercent = control ? change(perDay(control.before, 'orders'), perDay(control.after, 'orders')) : null;
  const productBefore = control ? sum(changed.before, control.before) : changed.before;
  const productAfter = control ? sum(changed.after, control.after) : changed.after;
  const productOrdersChangePercent = change(perDay(productBefore, 'orders'), perDay(productAfter, 'orders'));
  const base = { ordersChangePercent, controlOrdersChangePercent, productOrdersChangePercent, priceChangePercent };
  const direction = priceChangePercent < 0 ? 'снижение' : 'повышение';

  if (changed.before.orders + changed.after.orders < cfg.minOrders || productOrdersChangePercent === null) {
    return { ...base, verdict: 'INSUFFICIENT', note: `мало заказов для вывода (${changed.before.orders + changed.after.orders} за оба окна)` };
  }
  if (!control && (input.uncontrolledSkus ?? 0) > 0) {
    return { ...base, productOrdersChangePercent: null, verdict: 'INSUFFICIENT', note: `нет контроля: у остальных SKU товара с заказами (${input.uncontrolledSkus}) цена в окне тоже менялась — эффект не отделить (заказы SKU ${pct(ordersChangePercent)})` };
  }
  const product = productOrdersChangePercent;
  const own = ordersChangePercent ?? 0;
  const ctrl = controlOrdersChangePercent;
  const details = `заказы SKU ${pct(ordersChangePercent)}, контроль ${pct(ctrl)}, товар целиком ${pct(product)}`;

  // Каннибализация: у изменённых SKU рост, у контроля падение, товар в целом на месте.
  if (priceChangePercent < 0 && own > cfg.noEffectPercent && ctrl !== null && ctrl < -cfg.noEffectPercent && Math.abs(product) <= cfg.noEffectPercent) {
    return { ...base, verdict: 'CANNIBALIZED', note: `${direction} перетянуло покупателей с других цветов, по товару прироста нет (${details})` };
  }
  if (Math.abs(product) <= cfg.noEffectPercent) {
    return { ...base, verdict: 'NO_EFFECT', note: `${direction} не изменило продажи товара (${details})` };
  }
  // Для снижения «помогло» = товар вырос; для повышения «помогло» = товар не упал
  // сверх порога (выше уже отсечено как NO_EFFECT), т.е. рост — тоже успех.
  const helped = product > 0;
  return { ...base, verdict: helped ? 'HELPED' : 'HURT', note: `${direction} ${helped ? 'дало рост' : 'снизило продажи'} товара (${details})` };
}

export const VERDICT_LABELS: Record<ExperimentVerdict, string> = {
  HELPED: '✅ помогло',
  NO_EFFECT: '➖ без эффекта',
  HURT: '❌ навредило',
  CANNIBALIZED: '🔁 перетянуло с других цветов',
  INSUFFICIENT: '❔ мало данных',
};

/** Короткая сводка опыта магазина для ИИ-ревью автоцен и отчётов. */
export function summarizeExperiments(rows: Array<{ priceChangePercent: number; verdict: ExperimentVerdict }>): string | null {
  const known = rows.filter((row) => row.verdict !== 'INSUFFICIENT');
  if (!known.length) return null;
  const line = (label: string, list: typeof known) => {
    if (!list.length) return null;
    const count = (verdict: ExperimentVerdict) => list.filter((row) => row.verdict === verdict).length;
    return `${label} (${list.length}): помогло ${count('HELPED')}, без эффекта ${count('NO_EFFECT')}, перетянуло с других цветов ${count('CANNIBALIZED')}, навредило ${count('HURT')}`;
  };
  return [line('снижения цены', known.filter((row) => row.priceChangePercent < 0)), line('повышения цены', known.filter((row) => row.priceChangePercent > 0))]
    .filter(Boolean)
    .join('; ');
}

// ---------- внешний трафик (Instagram, Telegram, блогеры) ----------

export type MarketingResult = {
  verdict: 'HELPED' | 'NO_EFFECT' | 'INSUFFICIENT';
  /** % изменения заказов в день у продвигаемого товара. */
  ordersChangePercent: number | null;
  /** % изменения у остальных товаров магазина за те же дни (общий тренд). */
  controlOrdersChangePercent: number | null;
  /** Чистый эффект кампании: разница двух изменений, п.п. */
  liftPercent: number | null;
  /** Открытия карточки: изменение, % — внешний трафик виден здесь раньше заказов. */
  viewsChangePercent: number | null;
  note: string;
};

/**
 * Кампания вне Uzum: продвигаемый товар против остальных товаров магазина.
 * Сравнение с контролем отсекает общий тренд (праздники, сезон, поставки):
 * засчитываем только рост сверх того, что было у всего магазина.
 */
export function evaluateMarketing(
  input: { promoted: { before: FunnelTotals; after: FunnelTotals }; control: { before: FunnelTotals; after: FunnelTotals } | null; budget: number | null },
  cfg = EXPERIMENT_DEFAULTS,
): MarketingResult {
  const { promoted, control } = input;
  const ordersChangePercent = change(perDay(promoted.before, 'orders'), perDay(promoted.after, 'orders'));
  const viewsChangePercent = change(perDay(promoted.before, 'views'), perDay(promoted.after, 'views'));
  const controlOrdersChangePercent = control ? change(perDay(control.before, 'orders'), perDay(control.after, 'orders')) : null;
  const liftPercent = ordersChangePercent === null ? null : ordersChangePercent - (controlOrdersChangePercent ?? 0);
  const base = { ordersChangePercent, controlOrdersChangePercent, liftPercent, viewsChangePercent };
  if (promoted.before.orders + promoted.after.orders < cfg.minOrders || liftPercent === null) {
    return { ...base, verdict: 'INSUFFICIENT', note: `мало заказов для вывода (${promoted.before.orders + promoted.after.orders} за оба окна)` };
  }
  const extraOrders = Math.max(0, perDay(promoted.after, 'orders') - perDay(promoted.before, 'orders') * (1 + (controlOrdersChangePercent ?? 0) / 100)) * promoted.after.days;
  const cost = input.budget && extraOrders > 0 ? `, ≈ ${Math.round(input.budget / extraOrders).toLocaleString('ru-RU')} сум за дополнительный заказ` : '';
  const details = `заказы товара ${pct(ordersChangePercent)}, остальной магазин ${pct(controlOrdersChangePercent)}, открытия карточки ${pct(viewsChangePercent)}`;
  if (liftPercent > cfg.noEffectPercent) {
    return { ...base, verdict: 'HELPED', note: `кампания дала рост сверх общего тренда на ${Math.round(liftPercent)} п.п. (${details}; ≈ ${Math.round(extraOrders)} доп. заказов${cost})` };
  }
  return { ...base, verdict: 'NO_EFFECT', note: `роста сверх общего тренда нет (${details})` };
}
