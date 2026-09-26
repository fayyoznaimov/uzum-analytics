/**
 * Автоматическое ценообразование: правила и решение «что сделать с ценой SKU».
 *
 * Роли SKU:
 *   LOCOMOTIVE — лицевые полотенца (HAVANA 50×90 и другие лицевые): цену за поток не поднимаем,
 *     только +3% при запасе < 3 дней, после поставки возвращаем прежнюю цену;
 *   MARGINAL — все остальные:
 *     дефицит (запас < 7 дней) → +3%;
 *     поток (выкупы за 7 дней ≥ 1,2× среднего за 28 дней и ≥ 3 шт.) → +2%, если в эту неделю не менялись
 *       ставка или бюджет рекламы;
 *     после повышения за поток выкупы за 3 дня упали на 35% → возвращаем цену и 14 дней не поднимаем;
 *     ≤ 1 выкупа за 28 дней → −2%, если маржа после снижения не ниже минимальной.
 *
 * Общие ограничения: шаг ≤ 5% (checkPriceGuards), одно изменение цены SKU в сутки (любое — ручное тоже),
 * одно и то же правило не чаще раза в 7 дней, не больше 20 изменений за запуск. SKU с себестоимостью
 * 2–5 сум (пометка «не используется»), без себестоимости и с нулевым остатком пропускаем.
 *
 * Акции: цена в акции не может быть выше лимита «не более». Если повышать некуда (цена уже на лимите) —
 * не меняем, а рекомендуем поднять базовую цену после акции. Базовую цену SKU в акции не трогаем
 * (sendPriceData отвечает sku-price-001).
 *
 * Продажи и маржа — по выкупам (дата выдачи покупателю, за вычетом возвратов), не по заказам.
 * Запас в днях — из кабинета Uzum (getProducts: forecastOutOfStock, turnover, avgdsales).
 *
 * Модуль чистый: никакого I/O. Данные собирает AutoPricingService.
 */
import { recognizeSupplySku } from './fbo-supply-summary';
import { checkPriceGuards } from './pricing';

export const AUTO_PRICING_DEFAULTS = {
  locomotiveDeficitDays: 3,
  locomotiveRaisePercent: 3,
  /** Поставка пришла, если запас снова ≥ стольких дней… */
  locomotiveRestoreDays: 7,
  /** …или остаток вырос хотя бы вдвое и минимум на столько штук. */
  locomotiveRestoreMinUnits: 5,
  deficitDays: 7,
  deficitRaisePercent: 3,
  flowRatio: 1.2,
  flowMinWeeklyUnits: 3,
  flowRaisePercent: 2,
  revertDropPercent: 35,
  revertWindowDays: 3,
  /** Проверку «продажи упали после повышения» делаем не позже стольких дней после него. */
  revertCheckMaxDays: 10,
  raiseBanDays: 14,
  slowMaxUnits28: 1,
  slowLowerPercent: 2,
  minMarginPercent: 15,
  /** Одно и то же правило для SKU — не чаще раза в столько дней. */
  ruleCooldownDays: 7,
  maxStepPercent: 5,
  maxChangesPerRun: 20,
  unusedCostMin: 2,
  unusedCostMax: 5,
  priceRounding: 100,
  /** Бюджет рекламы (У000119) считаем изменившимся, если расход за неделю отличается от прошлой больше чем в столько раз. */
  adSpendChangeRatio: 1.3,
};
export type AutoPricingConfig = typeof AUTO_PRICING_DEFAULTS;

export type SkuRole = 'LOCOMOTIVE' | 'MARGINAL';
export type AutoRule = 'LOCO_DEFICIT' | 'LOCO_RESTORE' | 'DEFICIT' | 'FLOW' | 'FLOW_REVERT' | 'SLOW';
export const AUTO_RULES: AutoRule[] = ['LOCO_DEFICIT', 'LOCO_RESTORE', 'DEFICIT', 'FLOW', 'FLOW_REVERT', 'SLOW'];
export const AUTO_RULE_LABELS: Record<AutoRule, string> = {
  LOCO_DEFICIT: 'локомотив, дефицит',
  LOCO_RESTORE: 'локомотив, поставка — возврат цены',
  DEFICIT: 'дефицит',
  FLOW: 'поток',
  FLOW_REVERT: 'продажи упали после повышения — возврат',
  SLOW: 'нет продаж',
};
/** Порядок при срабатывании предохранителя: возвраты цены первыми. */
const RULE_PRIORITY: Record<AutoRule, number> = { FLOW_REVERT: 0, LOCO_RESTORE: 0, LOCO_DEFICIT: 1, DEFICIT: 2, FLOW: 3, SLOW: 4 };

export type PriceKind = 'BASE' | 'PROMO';

/** Отправленное (SENT) изменение цены SKU из журнала PriceChange — ручное или автоматическое. */
export type AutoPriceEvent = {
  at: Date;
  kind: PriceKind;
  oldPrice: number | null;
  newPrice: number;
  /** null — изменение не от автоцен (ручное, CLI). */
  rule: AutoRule | null;
  /** Остаток в момент изменения — для «после поставки вернуть». */
  stock: number | null;
  saleId?: number | null;
};

/** Участие SKU в акции (из API кабинета). */
export type AutoPromo = {
  saleId: number;
  saleTitle: string;
  /** CREATED — запланирована, ACTIVE — действует. */
  status: string;
  salePrice: number | null;
  maxPrice: number | null;
  basePrice: number | null;
};

/** Запас SKU по данным кабинета (getProducts → skuList[]). */
export type StockForecast = {
  skuId: string;
  quantity: number | null;
  avgDailySales: number | null;
  turnoverDays: number | null;
  outOfStockDays: number | null;
};

export type AutoPricingSkuInput = {
  skuId: string;
  productId: string;
  /** Артикул продавца (sellerSku) — по нему определяется роль. */
  title: string;
  role: SkuRole;
  /** Базовая цена из Uzum OpenAPI (во время акции там цена акции — поэтому base-изменения в акции не делаем). */
  basePrice: number | null;
  /** OpenAPI specialOffer.inOffer. */
  inOffer: boolean;
  promos: AutoPromo[];
  stock: number;
  /** SkuCost.amount — только для пометки «не используется». */
  costAmount: number | null;
  /** Полная себестоимость единицы. */
  unitCost: number | null;
  forecast: StockForecast | null;
  /** Выкупленные штуки по дням Asia/Tashkent (YYYY-MM-DD → шт.). */
  buyouts: Record<string, number>;
  /** Выплата Uzum / цена продажи по выкупам товара (null — нет выкупов с известной выплатой). */
  payoutRatio: number | null;
  /** Фактический расход на рекламу товара / выручка выкупов, % (null — не рассчитан). */
  adPercent: number | null;
  taxPercent: number;
  adChange: { changed: boolean; reason: string | null };
  /** Только отправленные (SENT) изменения, любой источник. */
  history: AutoPriceEvent[];
  minPrice: number | null;
  /** SKU заблокирован, в архиве или не найден в Uzum — причина пропуска. */
  unavailable?: string | null;
};

export type AutoDecisionStatus = 'CHANGE' | 'RECOMMEND' | 'HOLD' | 'SKIP';

export type AutoDecisionMetrics = {
  daysOfStock: number | null;
  daysOfStockSource: string | null;
  units7: number;
  units28: number;
  marginPercent: number | null;
  marginAfterPercent: number | null;
};

export type AutoDecision = {
  skuId: string;
  productId: string;
  title: string;
  role: SkuRole;
  status: AutoDecisionStatus;
  rule: AutoRule | null;
  kind: PriceKind | null;
  saleId: number | null;
  saleTitle: string | null;
  currentPrice: number | null;
  newPrice: number | null;
  deltaPercent: number | null;
  reason: string;
  metrics: AutoDecisionMetrics;
};

// ---------- даты (ключи YYYY-MM-DD в Asia/Tashkent) ----------

const DAY_MS = 86_400_000;
const keyToUtc = (key: string) => Date.parse(`${key}T00:00:00Z`);
export function shiftDay(key: string, days: number): string {
  return new Date(keyToUtc(key) + days * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((keyToUtc(toKey) - keyToUtc(fromKey)) / DAY_MS);
}
export function tashkentDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
/** Сумма по дням fromKey…toKey включительно. */
export function sumDays(byDay: Record<string, number>, fromKey: string, toKey: string): number {
  let total = 0;
  for (let key = fromKey; key <= toKey; key = shiftDay(key, 1)) total += byDay[key] ?? 0;
  return total;
}

// ---------- роли, пометки, запас ----------

/** Лицевые (в т.ч. HAVANA 50×90) — локомотивы; плюс явный список SKU ID из настроек. */
export function skuRole(sellerSku: string | null | undefined, skuId?: string, extraLocomotives: string[] = []): SkuRole {
  if (skuId && extraLocomotives.includes(skuId)) return 'LOCOMOTIVE';
  return recognizeSupplySku(String(sellerSku || ''))?.type === 'лицевой' ? 'LOCOMOTIVE' : 'MARGINAL';
}

/** Себестоимость 2–5 сум — пометка «SKU не используется». */
export function isUnusedCost(costAmount: number | null | undefined, cfg: Pick<AutoPricingConfig, 'unusedCostMin' | 'unusedCostMax'> = AUTO_PRICING_DEFAULTS): boolean {
  return typeof costAmount === 'number' && costAmount >= cfg.unusedCostMin && costAmount <= cfg.unusedCostMax;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** forecastOutOfStock → дней до конца запаса. Принимает дату (строка / мс / с) или число дней. */
export function outOfStockDays(value: unknown, now: Date): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const numeric = num(value);
  let at: number | null = null;
  if (numeric !== null) {
    if (numeric > 1e11) at = numeric;
    else if (numeric > 1e9) at = numeric * 1000;
    else return Math.max(0, numeric);
  } else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) at = parsed;
  }
  return at === null ? null : Math.max(0, (at - now.getTime()) / DAY_MS);
}

/**
 * Ответ кабинета GET api-seller.uzum.uz/api/seller/shop/{shopId}/product/getProducts:
 * товары со skuList[] и полями avgdsales, turnover, forecastOutOfStock.
 * Незнакомая форма — ошибка, а не «запаса нет».
 */
export function parseCabinetProducts(body: any, now: Date): StockForecast[] {
  const products = [body?.productList, body?.payload?.productList, body?.payload?.content, body?.content, body?.payload]
    .find(Array.isArray);
  if (!products) throw new Error('getProducts: неожиданная форма ответа (нет списка товаров)');
  const result: StockForecast[] = [];
  for (const product of products) {
    const skus = [product?.skuList, product?.skus].find(Array.isArray) || [];
    for (const sku of skus) {
      const skuId = num(sku?.skuId ?? sku?.id);
      if (skuId === null) continue;
      result.push({
        skuId: String(skuId),
        quantity: num(sku.quantityActive ?? sku.quantity ?? sku.availableAmount),
        avgDailySales: num(sku.avgdsales ?? sku.avgDailySales),
        turnoverDays: num(sku.turnover),
        outOfStockDays: outOfStockDays(sku.forecastOutOfStock, now),
      });
    }
  }
  return result;
}

/** Сколько товаров вернула страница getProducts (для постраничной выборки). */
export function cabinetProductsPageSize(body: any): number {
  const products = [body?.productList, body?.payload?.productList, body?.payload?.content, body?.content, body?.payload].find(Array.isArray);
  return products ? products.length : 0;
}

/** Запас в днях: прогноз кабинета → оборачиваемость → остаток / средние продажи в день. */
export function daysOfStock(forecast: StockForecast | null, stock: number): { days: number | null; source: string | null } {
  if (!forecast) return { days: null, source: null };
  if (forecast.outOfStockDays !== null) return { days: forecast.outOfStockDays, source: 'прогноз окончания' };
  if (forecast.turnoverDays !== null && forecast.turnoverDays >= 0) return { days: forecast.turnoverDays, source: 'оборачиваемость' };
  if (forecast.avgDailySales !== null && forecast.avgDailySales > 0) {
    return { days: (forecast.quantity ?? stock) / forecast.avgDailySales, source: 'остаток / продажи в день' };
  }
  return { days: null, source: null };
}

// ---------- выкупы, выплаты ----------

/** Заказ с уже определённым состоянием (classifyStoredOrder). Выкуп — только PAID, по дате выдачи. */
export type BuyoutOrder = {
  state: string;
  issuedAt: Date;
  /** Выплата Uzum и выручка заказа — уже за вычетом возвратов. */
  payout: number;
  payoutReported: boolean;
  gross: number;
  items: Array<{ skuId: string | null; productId: string | null; quantity: number; returns: number; amount: number }>;
};
export type BuyoutMoney = { gross: number; payout: number; payoutGross: number };

/**
 * Выкупленные штуки по SKU и дням (дата выдачи, без возвратов) и деньги выкупов по товарам и магазину.
 * Заказанные, но не выкупленные (выкуп 50×90 в августе 42–55%) сюда не попадают.
 */
export function aggregateBuyouts(orders: BuyoutOrder[]) {
  const bySku = new Map<string, Record<string, number>>();
  const products = new Map<string, BuyoutMoney>();
  const shop: BuyoutMoney = { gross: 0, payout: 0, payoutGross: 0 };
  const add = (target: BuyoutMoney, gross: number, payout: number, payoutGross: number) => {
    target.gross += gross; target.payout += payout; target.payoutGross += payoutGross;
  };
  for (const order of orders) {
    if (order.state !== 'PAID' || !order.items.length) continue;
    const day = tashkentDay(order.issuedAt);
    const itemsAmount = order.items.reduce((sum, item) => sum + Math.max(0, item.amount), 0);
    for (const item of order.items) {
      const units = Math.max(0, item.quantity - Math.max(0, item.returns));
      if (item.skuId && units > 0) {
        const row = bySku.get(item.skuId) ?? {};
        row[day] = (row[day] ?? 0) + units;
        bySku.set(item.skuId, row);
      }
      const share = itemsAmount > 0 ? Math.max(0, item.amount) / itemsAmount : 1 / order.items.length;
      const gross = order.gross * share;
      const payout = order.payoutReported ? order.payout * share : 0;
      const payoutGross = order.payoutReported ? gross : 0;
      add(shop, gross, payout, payoutGross);
      if (item.productId) {
        const money = products.get(item.productId) ?? { gross: 0, payout: 0, payoutGross: 0 };
        add(money, gross, payout, payoutGross);
        products.set(item.productId, money);
      }
    }
  }
  return { bySku, products, shop };
}

/** Доля выплаты Uzum в цене продажи по выкупам с известной выплатой. */
export function payoutRatio(money: BuyoutMoney | null | undefined): number | null {
  return money && money.payoutGross > 0 ? money.payout / money.payoutGross : null;
}

/** Фактическая реклама / выручка выкупов, %. Нет выкупов: без рекламы — 0, с рекламой — не рассчитана. */
export function adSharePercent(adSpend: number, money: BuyoutMoney | null | undefined): number | null {
  if (money && money.gross > 0) return (Math.max(0, adSpend) / money.gross) * 100;
  return adSpend > 0 ? null : 0;
}

// ---------- реклама ----------

/**
 * Менялись ли в последние 7 полных дней ставка «Буст заказов» (У000120, по наблюдённым ставкам)
 * или бюджет продвижения (У000119, по расходу к прошлой неделе).
 */
export function advertisingChanged(
  input: { rates: Array<{ percent: number; observedAt: Date }>; topSpendByDay: Record<string, number> },
  today: string,
  cfg: Pick<AutoPricingConfig, 'adSpendChangeRatio'> = AUTO_PRICING_DEFAULTS,
): { changed: boolean; reason: string | null } {
  const weekFrom = shiftDay(today, -7);
  const rates = [...input.rates].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const inWeek = rates.filter((rate) => tashkentDay(rate.observedAt) >= weekFrom);
  const before = rates.filter((rate) => tashkentDay(rate.observedAt) < weekFrom).pop();
  const weekPercents = [...new Set(inWeek.map((rate) => rate.percent))];
  if (weekPercents.length > 1 || (before && weekPercents.length && weekPercents[0] !== before.percent)) {
    const from = before?.percent ?? weekPercents[0];
    return { changed: true, reason: `ставка рекламы менялась: ${from}% → ${inWeek[inWeek.length - 1].percent}%` };
  }
  const week = sumDays(input.topSpendByDay, weekFrom, shiftDay(today, -1));
  const previous = sumDays(input.topSpendByDay, shiftDay(today, -14), shiftDay(today, -8));
  const ratio = cfg.adSpendChangeRatio;
  if ((week > 0) !== (previous > 0) || (week > 0 && previous > 0 && (week / previous > ratio || previous / week > ratio))) {
    return { changed: true, reason: `расход на продвижение: ${Math.round(previous)} → ${Math.round(week)} сум за неделю` };
  }
  return { changed: false, reason: null };
}

// ---------- маржа и цена ----------

/** Маржа, % от цены: выплата Uzum − реклама − налог − себестоимость. null — чего-то не знаем. */
export function marginPercent(price: number | null, input: Pick<AutoPricingSkuInput, 'unitCost' | 'payoutRatio' | 'adPercent' | 'taxPercent'>): number | null {
  if (!price || price <= 0 || input.unitCost === null || input.payoutRatio === null || input.adPercent === null) return null;
  return input.payoutRatio * 100 - input.adPercent - input.taxPercent - (input.unitCost / price) * 100;
}

/** Цена после изменения на percent: округляем до 100 сум в сторону изменения, если шаг от этого не выходит за лимит. */
export function adjustPrice(current: number, percent: number, cfg: Pick<AutoPricingConfig, 'priceRounding' | 'maxStepPercent'> = AUTO_PRICING_DEFAULTS): number {
  const raw = current * (1 + percent / 100);
  const step = cfg.priceRounding;
  const rounded = percent > 0 ? Math.ceil(raw / step) * step : Math.floor(raw / step) * step;
  const withinStep = Math.abs(rounded - current) <= (current * cfg.maxStepPercent) / 100;
  if (rounded !== current && withinStep) return rounded;
  return percent > 0 ? Math.ceil(raw) : Math.floor(raw);
}

// ---------- решение по одному SKU ----------

type Target = { rule: AutoRule; percent?: number; price?: number; revertOf?: AutoPriceEvent; reason: string };

const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');
const days1 = (value: number) => (Math.round(value * 10) / 10).toLocaleString('ru-RU');

export function evaluateSku(input: AutoPricingSkuInput, today: string, cfg: AutoPricingConfig = AUTO_PRICING_DEFAULTS): AutoDecision {
  const stockDays = daysOfStock(input.forecast, input.stock);
  const units7 = sumDays(input.buyouts, shiftDay(today, -7), shiftDay(today, -1));
  const units28 = sumDays(input.buyouts, shiftDay(today, -28), shiftDay(today, -1));
  const metrics: AutoDecisionMetrics = {
    daysOfStock: stockDays.days === null ? null : Math.round(stockDays.days * 10) / 10,
    daysOfStockSource: stockDays.source,
    units7,
    units28,
    marginPercent: null,
    marginAfterPercent: null,
  };
  const decision = (status: AutoDecisionStatus, reason: string, extra: Partial<AutoDecision> = {}): AutoDecision => ({
    skuId: input.skuId, productId: input.productId, title: input.title, role: input.role,
    status, rule: null, kind: null, saleId: null, saleTitle: null, currentPrice: null, newPrice: null, deltaPercent: null,
    reason, metrics, ...extra,
  });

  // Пропуски.
  if (input.unavailable) return decision('SKIP', input.unavailable);
  if (isUnusedCost(input.costAmount, cfg)) return decision('SKIP', 'не используется (себестоимость 2–5 сум)');
  if (input.stock <= 0) return decision('SKIP', 'нулевой остаток');
  if (input.unitCost === null) return decision('SKIP', 'нет себестоимости');
  const history = [...input.history].sort((a, b) => b.at.getTime() - a.at.getTime());
  if (history.some((event) => tashkentDay(event.at) === today)) return decision('SKIP', 'цена уже менялась сегодня');

  // Где живёт цена: действующая акция → цена в акции, иначе базовая.
  const active = input.promos.filter((promo) => promo.status === 'ACTIVE');
  const planned = input.promos.filter((promo) => promo.status !== 'ACTIVE');
  const promo = active.length === 1 ? active[0] : null;
  const kind: PriceKind = promo ? 'PROMO' : 'BASE';
  const currentPrice = promo ? promo.salePrice : input.basePrice;
  metrics.marginPercent = marginPercent(currentPrice, input);
  const where = { kind, saleId: promo?.saleId ?? null, saleTitle: promo?.saleTitle ?? null, currentPrice };

  const target = input.role === 'LOCOMOTIVE'
    ? locomotiveTarget(input, history, stockDays.days, cfg)
    : marginalTarget(input, history, stockDays.days, units7, units28, currentPrice, metrics, today, cfg);
  if ('hold' in target) return decision('HOLD', target.hold, where);

  const ruled = (status: AutoDecisionStatus, reason: string, extra: Partial<AutoDecision> = {}) =>
    decision(status, reason, { ...where, rule: target.rule, ...extra });

  if (active.length > 1) return ruled('RECOMMEND', `${target.reason}; SKU в нескольких акциях (${active.map((row) => `«${row.saleTitle}»`).join(', ')}) — менять вручную`, { kind: null, saleId: null, saleTitle: null });
  if (!promo && planned.length) return ruled('RECOMMEND', `${target.reason}; SKU в запланированной акции «${planned[0].saleTitle}» — базовую цену меняйте вручную`);
  if (!promo && input.inOffer) return ruled('RECOMMEND', `${target.reason}; Uzum показывает SKU в акции, но в кабинете акция не найдена — менять вручную`);
  if (currentPrice === null) return ruled('HOLD', `${target.reason}; текущая цена неизвестна`);

  let newPrice: number;
  if (target.revertOf) {
    const event = target.revertOf;
    if (event.newPrice !== currentPrice) return ruled('HOLD', `${target.reason}; цена уже изменена после повышения (${fmt(event.newPrice)} → ${fmt(currentPrice)}) — не трогаем`);
    if (event.kind !== kind || (kind === 'PROMO' && event.saleId && event.saleId !== promo?.saleId)) {
      return ruled('RECOMMEND', `${target.reason}; повышение было ${event.kind === 'PROMO' ? 'в акции' : 'базовой цены'} — вернуть ${fmt(event.oldPrice ?? 0)} вручную`, { newPrice: event.oldPrice });
    }
    newPrice = target.price as number;
  } else {
    newPrice = adjustPrice(currentPrice, target.percent as number, cfg);
  }

  let reason = target.reason;
  if (promo && newPrice > currentPrice) {
    if (promo.maxPrice === null) return ruled('RECOMMEND', `${reason}; лимит акции «не более» не получен — менять вручную`, { newPrice });
    if (currentPrice >= promo.maxPrice) {
      return ruled('RECOMMEND', `${reason}; цена в акции уже на лимите «не более» ${fmt(promo.maxPrice)} — поднять базовую после акции (цель ~${fmt(newPrice)})`, { newPrice });
    }
    if (newPrice > promo.maxPrice) {
      reason = `${reason}; ограничено лимитом акции «не более» ${fmt(promo.maxPrice)}`;
      newPrice = promo.maxPrice;
    }
  }

  const guards = checkPriceGuards({ currentPrice, newPrice, minPrice: input.minPrice, unitCost: input.unitCost, maxStepPercent: cfg.maxStepPercent });
  const deltaPercent = guards.deltaPercent === null ? null : Math.round(guards.deltaPercent * 100) / 100;
  if (guards.violations.length) return ruled('HOLD', `${reason}; защита: ${guards.violations.map((row) => row.message).join('; ')}`, { newPrice, deltaPercent });
  if (target.rule === 'SLOW') metrics.marginAfterPercent = marginPercent(newPrice, input);
  return ruled('CHANGE', reason, { newPrice, deltaPercent });
}

function locomotiveTarget(input: AutoPricingSkuInput, history: AutoPriceEvent[], days: number | null, cfg: AutoPricingConfig): Target | { hold: string } {
  const last = history[0];
  if (last?.rule === 'LOCO_DEFICIT') {
    const restocked = last.stock !== null && input.stock >= last.stock + Math.max(cfg.locomotiveRestoreMinUnits, last.stock);
    if ((days !== null && days >= cfg.locomotiveRestoreDays) || restocked) {
      if (last.oldPrice === null) return { hold: 'поставка пришла, но прежняя цена неизвестна' };
      const why = restocked ? `остаток ${last.stock} → ${input.stock} шт.` : `запас ${days1(days as number)} дн.`;
      return { rule: 'LOCO_RESTORE', price: last.oldPrice, revertOf: last, reason: `поставка пришла (${why}) — вернуть ${fmt(last.oldPrice)}` };
    }
    return { hold: 'цена поднята из-за дефицита — ждём поставку' };
  }
  if (days === null) return { hold: 'нет данных о запасе из кабинета' };
  if (days < cfg.locomotiveDeficitDays) {
    return { rule: 'LOCO_DEFICIT', percent: cfg.locomotiveRaisePercent, reason: `запас ${days1(days)} дн. < ${cfg.locomotiveDeficitDays} — +${cfg.locomotiveRaisePercent}%` };
  }
  return { hold: 'локомотив: за поток цену не поднимаем' };
}

function marginalTarget(
  input: AutoPricingSkuInput,
  history: AutoPriceEvent[],
  days: number | null,
  units7: number,
  units28: number,
  currentPrice: number | null,
  metrics: AutoDecisionMetrics,
  today: string,
  cfg: AutoPricingConfig,
): Target | { hold: string } {
  const since = (event: AutoPriceEvent) => daysBetween(tashkentDay(event.at), today);
  const recent = (rule: AutoRule, withinDays: number) => history.some((event) => event.rule === rule && since(event) < withinDays);
  const notes: string[] = [];

  // 1. Возврат после повышения за поток, если выкупы упали.
  const last = history[0];
  if (last?.rule === 'FLOW' && last.oldPrice !== null && last.newPrice > last.oldPrice) {
    const raisedOn = tashkentDay(last.at);
    const elapsed = since(last);
    if (elapsed > cfg.revertWindowDays && elapsed <= cfg.revertCheckMaxDays) {
      const after = sumDays(input.buyouts, shiftDay(raisedOn, 1), shiftDay(raisedOn, cfg.revertWindowDays));
      const baseline = (sumDays(input.buyouts, shiftDay(raisedOn, -28), shiftDay(raisedOn, -1)) / 28) * cfg.revertWindowDays;
      if (baseline > 0 && after <= baseline * (1 - cfg.revertDropPercent / 100)) {
        const drop = Math.round((1 - after / baseline) * 100);
        return { rule: 'FLOW_REVERT', price: last.oldPrice, revertOf: last, reason: `после повышения ${tashkentDay(last.at)} выкупы за ${cfg.revertWindowDays} дн. ${after} шт. против ~${days1(baseline)} (−${drop}%) — вернуть ${fmt(last.oldPrice)}, ${cfg.raiseBanDays} дн. не поднимать` };
      }
    }
  }
  const raiseBanned = recent('FLOW_REVERT', cfg.raiseBanDays);

  // 2. Дефицит.
  if (days !== null && days < cfg.deficitDays) {
    if (raiseBanned) notes.push(`дефицит ${days1(days)} дн., но после возврата цены ${cfg.raiseBanDays} дн. не поднимаем`);
    else if (recent('DEFICIT', cfg.ruleCooldownDays)) notes.push(`дефицит ${days1(days)} дн., цена уже поднималась за дефицит в последние ${cfg.ruleCooldownDays} дн.`);
    else return { rule: 'DEFICIT', percent: cfg.deficitRaisePercent, reason: `запас ${days1(days)} дн. < ${cfg.deficitDays} — +${cfg.deficitRaisePercent}%` };
  }

  // 3. Поток.
  const weeklyAverage = units28 / 4;
  if (units7 >= cfg.flowMinWeeklyUnits && units7 >= weeklyAverage * cfg.flowRatio) {
    const flow = `выкупы ${units7} шт. за 7 дн. при среднем ${days1(weeklyAverage)} шт./нед.`;
    if (raiseBanned) notes.push(`${flow}, но после возврата цены ${cfg.raiseBanDays} дн. не поднимаем`);
    else if (input.adChange.changed) notes.push(`${flow}, но на неделе менялась реклама (${input.adChange.reason}) — поток не считаем`);
    else if (recent('FLOW', cfg.ruleCooldownDays) || recent('DEFICIT', cfg.ruleCooldownDays)) notes.push(`${flow}, цена уже поднималась в последние ${cfg.ruleCooldownDays} дн.`);
    else return { rule: 'FLOW', percent: cfg.flowRaisePercent, reason: `${flow} (×${days1(units7 / Math.max(weeklyAverage, 0.01))}) — +${cfg.flowRaisePercent}%` };
  }

  // 4. Нет продаж.
  if (units28 <= cfg.slowMaxUnits28) {
    const slow = `${units28} выкуп. за 28 дн.`;
    if (recent('SLOW', cfg.ruleCooldownDays)) return { hold: notes.concat(`${slow}, цена уже снижалась в последние ${cfg.ruleCooldownDays} дн.`).join('; ') };
    if (currentPrice === null) return { hold: notes.concat(`${slow}, текущая цена неизвестна`).join('; ') };
    const after = marginPercent(adjustPrice(currentPrice, -cfg.slowLowerPercent, cfg), input);
    metrics.marginAfterPercent = after;
    if (after === null) return { hold: notes.concat(`${slow}, маржа не рассчитана (нет выплат или расхода на рекламу) — не снижаем`).join('; ') };
    if (after < cfg.minMarginPercent) return { hold: notes.concat(`${slow}, маржа после снижения ${days1(after)}% < ${cfg.minMarginPercent}% — не снижаем`).join('; ') };
    return { rule: 'SLOW', percent: -cfg.slowLowerPercent, reason: `${slow} — −${cfg.slowLowerPercent}% (маржа после ${days1(after)}%)` };
  }
  return { hold: notes.length ? notes.join('; ') : 'правила не сработали' };
}

// ---------- запуск целиком ----------

export type AutoPricingPlan = {
  changes: AutoDecision[];
  /** Сработали, но не вошли в лимит изменений за запуск. */
  deferred: AutoDecision[];
  recommendations: AutoDecision[];
  holds: AutoDecision[];
  skips: AutoDecision[];
};

export function planAutoPricingRun(decisions: AutoDecision[], cfg: Pick<AutoPricingConfig, 'maxChangesPerRun'> = AUTO_PRICING_DEFAULTS): AutoPricingPlan {
  const candidates = decisions
    .filter((row) => row.status === 'CHANGE')
    .sort((a, b) => RULE_PRIORITY[a.rule as AutoRule] - RULE_PRIORITY[b.rule as AutoRule] || a.title.localeCompare(b.title));
  return {
    changes: candidates.slice(0, cfg.maxChangesPerRun),
    deferred: candidates.slice(cfg.maxChangesPerRun),
    recommendations: decisions.filter((row) => row.status === 'RECOMMEND'),
    holds: decisions.filter((row) => row.status === 'HOLD'),
    skips: decisions.filter((row) => row.status === 'SKIP'),
  };
}

// ---------- отчёт в Telegram ----------

export type AutoPricingOutcome = { skuId: string; ok: boolean; message: string };

export type AutoPricingReportOptions = {
  apply: boolean;
  /** Время запуска для заголовка, «26.09 09:30». */
  label: string;
  stockNote: string | null;
  /** Итог ИИ-проверки: «проверено моделью …» или почему не выполнена. */
  aiNote?: string | null;
  outcomes?: AutoPricingOutcome[];
  maxChangesPerRun: number;
};

const TELEGRAM_CHUNK = 3900;

function line(row: AutoDecision) {
  const where = row.kind === 'PROMO' ? ` в акции «${row.saleTitle}»` : row.kind === 'BASE' ? ' (базовая)' : '';
  const price = row.currentPrice !== null && row.newPrice !== null
    ? `: ${fmt(row.currentPrice)} → ${fmt(row.newPrice)}${row.deltaPercent !== null ? ` (${row.deltaPercent > 0 ? '+' : ''}${row.deltaPercent.toLocaleString('ru-RU')}%)` : ''}`
    : '';
  const role = row.role === 'LOCOMOTIVE' ? ' 🚂' : '';
  return `• ${row.title || row.skuId} [${row.skuId}]${role}${price}${where} — ${row.reason}`;
}

/** Текст отчёта, разбитый на сообщения до ~3900 символов. */
export function formatAutoPricingReport(plan: AutoPricingPlan, options: AutoPricingReportOptions): string[] {
  const outcomes = new Map((options.outcomes ?? []).map((row) => [row.skuId, row]));
  const lines: string[] = [
    `🤖 Автоцены — ${options.label}`,
    options.apply ? 'Режим: изменение цен включено' : 'Режим: только рекомендации — цены не меняются',
  ];
  if (options.aiNote) lines.push(`🧠 ${options.aiNote}`);
  if (options.stockNote) lines.push(`⚠️ ${options.stockNote}`);
  lines.push('');
  if (plan.changes.length) {
    lines.push(options.apply ? `Изменения (${plan.changes.length}):` : `Рекомендую изменить (${plan.changes.length}):`);
    for (const row of plan.changes) {
      const outcome = outcomes.get(row.skuId);
      lines.push(line(row) + (outcome ? (outcome.ok ? ` ✅ ${outcome.message}` : ` ❌ ${outcome.message}`) : ''));
    }
    lines.push('');
  } else {
    lines.push('Изменений цены нет.', '');
  }
  if (plan.deferred.length) {
    lines.push(`Отложено предохранителем — больше ${options.maxChangesPerRun} SKU за запуск (${plan.deferred.length}):`, ...plan.deferred.map(line), '');
  }
  if (plan.recommendations.length) {
    lines.push(`Сделать вручную (${plan.recommendations.length}):`, ...plan.recommendations.map(line), '');
  }
  const skipped = new Map<string, number>();
  for (const row of plan.skips) skipped.set(row.reason, (skipped.get(row.reason) ?? 0) + 1);
  if (skipped.size) lines.push(`Пропущено: ${[...skipped].map(([reason, count]) => `${reason} — ${count}`).join(', ')}`);
  lines.push(`Без изменений: ${plan.holds.length} SKU`);
  lines.push('Продажи и маржа — по выкупам (дата выдачи, без возвратов); маржа — оценка по выплатам Uzum и фактической рекламе за 90 дней.');

  const chunks: string[] = [];
  let current = '';
  for (const text of lines) {
    const piece = text.length > TELEGRAM_CHUNK ? `${text.slice(0, TELEGRAM_CHUNK - 1)}…` : text;
    if (current && current.length + piece.length + 1 > TELEGRAM_CHUNK) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}
