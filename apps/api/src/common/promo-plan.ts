/**
 * План цен для участия в акции Uzum — только рекомендации, ничего не меняет.
 *
 * Якорь — средняя цена, по которой SKU реально выкупали за последние 28 дней (нет выкупов — за 90):
 * это уровень, на котором товар продавался в прошлых акциях. От якоря:
 *  - мало остатка (≤ lowStockUnits шт. или запас < lowStockDays дн.) — минимальная скидка от базовой;
 *  - почти нет продаж (≤ slowMaxUnits28 шт. за 28 дней) — ниже якоря на slowCutPercent,
 *    без якоря — базовая −slowNoAnchorPercent;
 *  - поток (7 дней ≥ flowRatio × среднего за 28, ≥ flowMinWeeklyUnits шт.) и запас ≥ flowMinStockDays дн. —
 *    якорь +flowRaisePercent (лицевые не поднимаем: это вход в магазин);
 *  - остальное — якорь.
 * Потолок — базовая цена −minDiscountPercent: базовая — «не более» для цены в акции.
 * Пол — цена с маржой ≥ minMarginPercent. Без себестоимости маржа не проверяется, и это видно в строке.
 * Цены — «…900» (140 900, 69 900), как в магазине.
 */
import { AutoPricingSkuInput, daysOfStock, isUnusedCost, marginPercent, shiftDay, sumDays } from './auto-pricing';

export const PROMO_PLAN_DEFAULTS = {
  minDiscountPercent: 1,
  minMarginPercent: 15,
  lowStockUnits: 3,
  lowStockDays: 7,
  slowMaxUnits28: 1,
  slowCutPercent: 7,
  slowNoAnchorPercent: 20,
  flowRatio: 1.2,
  flowMinWeeklyUnits: 3,
  flowMinStockDays: 14,
  flowRaisePercent: 3,
};
export type PromoPlanConfig = typeof PROMO_PLAN_DEFAULTS;

export type PromoPlanRow = {
  skuId: string;
  productId: string;
  title: string;
  /** PRICE — предлагаем цену; SKIP — в акцию не добавлять (причина в reason). */
  status: 'PRICE' | 'SKIP';
  basePrice: number | null;
  stock: number;
  daysOfStock: number | null;
  units7: number;
  units28: number;
  /** Средняя цена выкупов и за сколько дней она посчитана. */
  soldPrice: number | null;
  soldPriceDays: 28 | 90 | null;
  unitCost: number | null;
  /** Цена с маржой ровно minMarginPercent (null — себестоимость или выплата неизвестны). */
  floorPrice: number | null;
  price: number | null;
  discountPercent: number | null;
  marginPercent: number | null;
  reason: string;
};

/** Вниз до «…900»: 141 234 → 140 900, 141 950 → 141 900, 69 900 → 69 900. */
export function niceDown(price: number): number {
  return Math.floor((price + 100) / 1000) * 1000 - 100;
}
/** Вверх до «…900»: 140 901 → 141 900, 69 900 → 69 900. */
export function niceUp(price: number): number {
  return Math.ceil((price + 100) / 1000) * 1000 - 100;
}

/** Средняя цена выкупов за дни fromKey…toKey (null — выкупов не было или нет выручки). */
export function soldPrice(input: Pick<AutoPricingSkuInput, 'buyouts' | 'buyoutRevenue'>, fromKey: string, toKey: string): number | null {
  const units = sumDays(input.buyouts, fromKey, toKey);
  const revenue = sumDays(input.buyoutRevenue ?? {}, fromKey, toKey);
  return units > 0 && revenue > 0 ? revenue / units : null;
}

/** Цена, при которой маржа ровно minMarginPercent (та же формула, что marginPercent). */
export function promoFloorPrice(input: Pick<AutoPricingSkuInput, 'unitCost' | 'payoutRatio' | 'adPercent' | 'taxPercent'>, minMarginPercent: number): number | null {
  if (input.unitCost === null || input.payoutRatio === null || input.adPercent === null) return null;
  const left = input.payoutRatio * 100 - input.adPercent - input.taxPercent - minMarginPercent;
  return left > 0 ? (input.unitCost * 100) / left : null;
}

const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');

export function planPromoSku(input: AutoPricingSkuInput, today: string, cfg: PromoPlanConfig = PROMO_PLAN_DEFAULTS): PromoPlanRow {
  const yesterday = shiftDay(today, -1);
  const units7 = sumDays(input.buyouts, shiftDay(yesterday, -6), yesterday);
  const units28 = sumDays(input.buyouts, shiftDay(yesterday, -27), yesterday);
  const sold28 = soldPrice(input, shiftDay(yesterday, -27), yesterday);
  const sold90 = sold28 === null ? soldPrice(input, shiftDay(yesterday, -89), yesterday) : null;
  const anchor = sold28 ?? sold90;
  const stockDays = daysOfStock(input.forecast, input.stock).days;
  const row: PromoPlanRow = {
    skuId: input.skuId, productId: input.productId, title: input.title, status: 'SKIP',
    basePrice: input.basePrice, stock: input.stock, daysOfStock: stockDays, units7, units28,
    soldPrice: anchor, soldPriceDays: sold28 !== null ? 28 : sold90 !== null ? 90 : null,
    unitCost: input.unitCost, floorPrice: promoFloorPrice(input, cfg.minMarginPercent),
    price: null, discountPercent: null, marginPercent: null, reason: '',
  };
  const skip = (reason: string) => ({ ...row, reason });
  if (input.unavailable) return skip(input.unavailable);
  if (!input.basePrice) return skip('нет базовой цены');
  if (isUnusedCost(input.costAmount)) return skip('SKU не используется (себестоимость 2–5 сум)');
  if (input.stock <= 0) return skip('нет остатка');

  const base = input.basePrice;
  const ceiling = niceDown(base * (1 - cfg.minDiscountPercent / 100));
  const lowStock = input.stock <= cfg.lowStockUnits || (stockDays !== null && stockDays < cfg.lowStockDays);
  const flow = units7 >= cfg.flowMinWeeklyUnits && units7 >= (cfg.flowRatio * units28) / 4 && (stockDays === null || stockDays >= cfg.flowMinStockDays);

  let target: number;
  let reason: string;
  if (lowStock) {
    target = ceiling;
    reason = `мало остатка (${input.stock} шт.${stockDays !== null ? `, запас ${Math.round(stockDays)} дн.` : ''}) — минимальная скидка`;
  } else if (units28 <= cfg.slowMaxUnits28) {
    target = anchor !== null ? anchor * (1 - cfg.slowCutPercent / 100) : base * (1 - cfg.slowNoAnchorPercent / 100);
    reason = anchor !== null
      ? `почти нет продаж (${units28} шт. за 28 дн.) — на ${cfg.slowCutPercent}% ниже цены продаж ${fmt(anchor)}`
      : `нет продаж за 90 дн. — базовая −${cfg.slowNoAnchorPercent}%`;
  } else if (flow && anchor !== null && input.role !== 'LOCOMOTIVE') {
    target = anchor * (1 + cfg.flowRaisePercent / 100);
    reason = `хорошо продаётся (${units7} шт. за 7 дн.) — цена продаж ${fmt(anchor)} +${cfg.flowRaisePercent}%`;
  } else {
    target = anchor ?? base * (1 - cfg.slowNoAnchorPercent / 100);
    reason = `цена, по которой продавался последние ${sold28 !== null ? 28 : 90} дн.${flow && input.role === 'LOCOMOTIVE' ? ' (лицевое — не поднимаем, это вход в магазин)' : ''}`;
  }

  let price = Math.min(niceDown(target), ceiling);
  if (price === ceiling && !lowStock && target > ceiling) reason += `; не выше базовой −${cfg.minDiscountPercent}%`;
  if (row.floorPrice !== null && price < row.floorPrice) {
    const floor = niceUp(row.floorPrice);
    if (floor > ceiling) return skip(`даже при скидке ${cfg.minDiscountPercent}% маржа ниже ${cfg.minMarginPercent}% — в акцию не добавлять`);
    price = floor;
    reason += `; поднято до маржи ${cfg.minMarginPercent}%`;
  }
  if (input.unitCost === null) reason += '; себестоимость не задана — маржа не проверена';
  return {
    ...row, status: 'PRICE', price, reason,
    discountPercent: Math.round((1 - price / base) * 1000) / 10,
    marginPercent: marginPercent(price, input),
  };
}

export function planPromoPrices(inputs: AutoPricingSkuInput[], today: string, cfg: PromoPlanConfig = PROMO_PLAN_DEFAULTS): PromoPlanRow[] {
  return inputs
    .map((input) => planPromoSku(input, today, cfg))
    .sort((a, b) => a.productId.localeCompare(b.productId) || a.title.localeCompare(b.title));
}

/** Текст плана: по товарам, строка на SKU; в конце — что пропущено и почему. */
export function formatPromoPlan(rows: PromoPlanRow[], productTitles: Map<string, string> = new Map()): string[] {
  const lines: string[] = [];
  const priced = rows.filter((row) => row.status === 'PRICE');
  let product = '';
  for (const row of priced) {
    if (row.productId !== product) {
      product = row.productId;
      lines.push('', `=== Товар ${product}${productTitles.get(product) ? ` — ${productTitles.get(product)}` : ''} ===`);
      lines.push('SKU | артикул | остаток | выкуп 7/28 дн. | цена продаж | базовая | себест. | цена в акции | скидка | маржа | почему');
    }
    const sold = row.soldPrice !== null ? `${fmt(row.soldPrice)} (${row.soldPriceDays} дн.)` : '—';
    const margin = row.marginPercent !== null ? `${row.marginPercent.toFixed(0)}%` : 'не рассчитана';
    lines.push(`${row.skuId} | ${row.title} | ${row.stock} | ${row.units7}/${row.units28} | ${sold} | ${fmt(row.basePrice ?? 0)} | ${row.unitCost !== null ? fmt(row.unitCost) : '—'} | ${fmt(row.price ?? 0)} | ${row.discountPercent}% | ${margin} | ${row.reason}`);
  }
  const skipped = rows.filter((row) => row.status === 'SKIP');
  if (skipped.length) {
    lines.push('', '=== Не добавлять в акцию ===');
    for (const row of skipped) lines.push(`${row.skuId} | ${row.title} | ${row.reason}`);
  }
  lines.push('', `Итого: цена предложена для ${priced.length} SKU, не добавлять ${skipped.length}.`);
  return lines;
}
