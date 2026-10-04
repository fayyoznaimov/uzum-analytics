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
 */

export type FunnelTotals = { impressions: number; views: number; carts: number; orders: number; days: number };

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

export function evaluateExperiment(
  input: { changed: { before: FunnelTotals; after: FunnelTotals }; control: { before: FunnelTotals; after: FunnelTotals } | null; priceChangePercent: number },
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
