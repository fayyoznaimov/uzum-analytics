/**
 * Проверки и формирование запроса на изменение цены SKU через
 * POST /v1/product/{shopId}/sendPriceData (Seller OpenAPI, operationId saveProductPriceData).
 *
 * Схема тела из Swagger (SendPriceData): { productId: int64, skuList: NewPriceSku[] },
 * NewPriceSku: { skuId: int64 (обяз.), sellPrice?: int64, fullPrice?: int64, skuTitle?: string },
 * цены — целые суммы в сумах, 1…999 999 000.
 *
 * Модуль чистый: никакого I/O, только решение «можно / нельзя и почему».
 * На нём же будет строиться автоматическое ценообразование, поэтому все
 * ограничения собраны здесь, а не в сервисе.
 */

export const UZUM_PRICE_MIN = 1;
export const UZUM_PRICE_MAX = 999_999_000;
export const DEFAULT_MAX_STEP_PERCENT = 5;

export type PriceViolationCode =
  | 'INVALID_PRICE'
  | 'INVALID_FULL_PRICE'
  | 'CURRENT_PRICE_UNKNOWN'
  | 'NO_CHANGE'
  | 'STEP_TOO_LARGE'
  | 'BELOW_MIN_PRICE'
  | 'BELOW_UNIT_COST'
  | 'NO_FLOOR'
  | 'SKU_BLOCKED'
  | 'SKU_ARCHIVED'
  | 'IN_PROMO';

export type PriceViolation = { code: PriceViolationCode; message: string };

export type PriceChangeInput = {
  shopExternalId: string;
  productExternalId: string;
  skuExternalId: string;
  /** Текущая цена продажи, прочитанная из Uzum непосредственно перед изменением. */
  currentPrice: number | null;
  newPrice: number;
  /** Полная (зачёркнутая) цена. Отправляется только если задана явно. */
  fullPrice?: number | null;
  /** Название SKU (поле skuTitle в NewPriceSku). Отправляется только если задано. */
  skuTitle?: string | null;
  /** Абсолютный порог: ниже этой цены не опускаемся. */
  minPrice?: number | null;
  /** Полная себестоимость единицы (товар + упаковка + логистика + прочее), если известна. */
  unitCost?: number | null;
  maxStepPercent?: number;
  blocked?: boolean;
  archived?: boolean;
  /** SKU участвует в акции Uzum (specialOffer.inOffer). */
  inPromo?: boolean;
  promoName?: string | null;
  allowDuringPromo?: boolean;
};

export type SendPriceDataBody = {
  productId: number;
  skuList: Array<{ skuId: number; sellPrice: number; fullPrice?: number; skuTitle?: string }>;
};

export type PriceChangePlan = {
  allowed: boolean;
  violations: PriceViolation[];
  deltaPercent: number | null;
  floor: number | null;
  path: string;
  body: SendPriceDataBody;
};

const isUzumPrice = (value: number) => Number.isInteger(value) && value >= UZUM_PRICE_MIN && value <= UZUM_PRICE_MAX;
const positive = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

export type PriceGuardInput = {
  /** Текущая цена, прочитанная из Uzum непосредственно перед изменением. */
  currentPrice: number | null;
  newPrice: number;
  /** Абсолютный порог: ниже этой цены не опускаемся. */
  minPrice?: number | null;
  /** Полная себестоимость единицы (товар + упаковка + логистика + прочее), если известна. */
  unitCost?: number | null;
  maxStepPercent?: number;
};

export type PriceGuardResult = { violations: PriceViolation[]; deltaPercent: number | null; floor: number | null };

/**
 * Общие защиты любого изменения цены — базовой (sendPriceData) и акционной (кабинет):
 * корректная сумма, шаг не больше ±maxStepPercent от текущей, не ниже минимальной цены
 * и себестоимости, без порога не меняем вовсе.
 */
export function checkPriceGuards(input: PriceGuardInput): PriceGuardResult {
  const violations: PriceViolation[] = [];
  const maxStepPercent = input.maxStepPercent ?? DEFAULT_MAX_STEP_PERCENT;
  const currentPrice = positive(input.currentPrice);
  const minPrice = positive(input.minPrice);
  const unitCost = positive(input.unitCost);
  const floor = minPrice || unitCost ? Math.max(minPrice ?? 0, unitCost ?? 0) : null;

  if (!isUzumPrice(input.newPrice)) {
    violations.push({ code: 'INVALID_PRICE', message: `Цена должна быть целым числом от ${UZUM_PRICE_MIN} до ${UZUM_PRICE_MAX}` });
  }

  let deltaPercent: number | null = null;
  if (currentPrice === null) {
    violations.push({ code: 'CURRENT_PRICE_UNKNOWN', message: 'Текущая цена в Uzum не получена — шаг изменения проверить нельзя' });
  } else {
    deltaPercent = ((input.newPrice - currentPrice) / currentPrice) * 100;
    if (input.newPrice === currentPrice) {
      violations.push({ code: 'NO_CHANGE', message: 'Новая цена совпадает с текущей' });
    } else if (Math.abs(input.newPrice - currentPrice) > (currentPrice * maxStepPercent) / 100) {
      violations.push({ code: 'STEP_TOO_LARGE', message: `Изменение ${deltaPercent.toFixed(2)}% превышает допустимый шаг ±${maxStepPercent}%` });
    }
  }

  if (floor === null) {
    violations.push({ code: 'NO_FLOOR', message: 'Не задана минимальная цена и неизвестна себестоимость — без порога цену не меняем' });
  }
  if (minPrice !== null && input.newPrice < minPrice) {
    violations.push({ code: 'BELOW_MIN_PRICE', message: `Цена ниже минимального порога ${minPrice}` });
  }
  if (unitCost !== null && input.newPrice < unitCost) {
    violations.push({ code: 'BELOW_UNIT_COST', message: `Цена ниже себестоимости единицы ${Math.round(unitCost)}` });
  }
  return { violations, deltaPercent, floor };
}

export function planPriceChange(input: PriceChangeInput): PriceChangePlan {
  const { violations, deltaPercent, floor } = checkPriceGuards(input);
  const fullPrice = input.fullPrice ?? null;
  if (fullPrice !== null && (!isUzumPrice(fullPrice) || fullPrice < input.newPrice)) {
    violations.push({ code: 'INVALID_FULL_PRICE', message: 'Полная цена должна быть целым числом и не ниже цены продажи' });
  }
  if (input.blocked) violations.push({ code: 'SKU_BLOCKED', message: 'SKU заблокирован в Uzum' });
  if (input.archived) violations.push({ code: 'SKU_ARCHIVED', message: 'SKU в архиве' });
  if (input.inPromo && !input.allowDuringPromo) {
    violations.push({ code: 'IN_PROMO', message: `SKU участвует в акции${input.promoName ? ` «${input.promoName}»` : ''} — изменение цены может снять его с акции` });
  }

  const sku: SendPriceDataBody['skuList'][number] = { skuId: Number(input.skuExternalId), sellPrice: input.newPrice };
  if (fullPrice !== null) sku.fullPrice = fullPrice;
  if (input.skuTitle) sku.skuTitle = input.skuTitle;

  return {
    allowed: violations.length === 0,
    violations,
    deltaPercent,
    floor,
    path: `/v1/product/${input.shopExternalId}/sendPriceData`,
    body: { productId: Number(input.productExternalId), skuList: [sku] },
  };
}
