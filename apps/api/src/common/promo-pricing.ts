/**
 * Акционные цены Uzum через внутренний API кабинета (тот же Bearer-токен сессии, что
 * у интеграции UZUM_INTERNAL). В Seller OpenAPI методов для акций нет, а sendPriceData
 * на SKU в акции отвечает sku-price-001, поэтому цену в акции меняем как кабинет.
 *
 * Запросы сняты со страницы «Участие в акции» 25.09.2026 (акция 393, SKU 10616545):
 *   GET  {base}/shop/{shopId}/marketing/sales?page&size&saleType=ALL  → payload: Sale[]
 *   GET  {base}/shop/{shopId}/marketing/sales/{saleId}                 → payload: Sale + priceRule
 *   GET  {base}/shop/{shopId}/marketing/sales/{saleId}/products?page&size
 *        → payload.content: [{ productId, skuList: [{ skuId, skuTitle, availableCount,
 *          currentSellPrice (базовая цена), salePrice (цена в акции), maxSuitablePrice («не более») }] }]
 *   POST {base}/shop/{shopId}/marketing/sales/{saleId}/products
 *        { products: [{ productId, skuList: [{ skuId, newSalePrice }] }] } → { payload: null }
 *        Кабинет отправляет товар целиком — все его SKU в акции, изменённый и неизменные.
 *   POST {base}/shop/{shopId}/marketing/sales/{saleId}/calculate-to-withdraw
 *        [{ productId, skuId, newSalePrice }] → payload: [{ …, toWithdraw }]
 *
 * Модуль чистый: разбор ответов и решение «можно / нельзя и почему». Сеть — в PromoPricingService.
 */
import { checkPriceGuards, PriceViolation, PriceViolationCode } from './pricing';

export const UZUM_PROMO_API_BASE = 'https://api.uzum.uz/api/seller';
export const PROMO_TOKEN_EXPIRED_MESSAGE = 'Сессия кабинета Uzum истекла (HTTP 401) — обновите токен в Настройки → Отзывы Uzum';

/** Статусы, в которых цену в акции ещё можно менять: CREATED — «Запланирована», ACTIVE — «Действует». */
export const EDITABLE_SALE_STATUSES = ['CREATED', 'ACTIVE'];

export type PromoViolationCode =
  | PriceViolationCode
  | 'NOT_IN_SALE'
  | 'SALE_NOT_EDITABLE'
  | 'ABOVE_PROMO_LIMIT'
  | 'OUTSIDE_SALE_PRICE_RULE';

export type PromoViolation = { code: PromoViolationCode; message: string };

export type PromoSale = {
  id: number;
  title: string;
  status: string;
  type: string | null;
  startDate: string | null;
  finishDate: string | null;
  involvedProductsCount: number | null;
  /** priceRule из карточки акции — есть только в GET sales/{id}. */
  priceRule: { minPrice: number | null; maxPrice: number | null } | null;
};

export type PromoSku = {
  saleId: number;
  productId: number;
  skuId: number;
  skuTitle: string | null;
  availableCount: number | null;
  /** Базовая цена SKU (в OpenAPI во время акции её не видно). */
  basePrice: number | null;
  /** Текущая цена в акции. */
  salePrice: number | null;
  /** Лимит «не более N» со страницы акции. */
  maxPrice: number | null;
};

const int = (value: unknown): number | null => {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? Math.round(parsed) : null;
};
const text = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));
const title = (value: any): string => text(typeof value === 'object' && value ? value.ru ?? value.uz : value) ?? '';

function parseSale(row: any): PromoSale {
  const rule = row?.priceRule;
  return {
    id: Number(row.id),
    title: title(row.title),
    status: String(row.status ?? ''),
    type: text(row.type),
    startDate: text(row.startDate),
    finishDate: text(row.finishDate),
    involvedProductsCount: int(row.involvedProductsCount),
    priceRule: rule ? { minPrice: int(rule.minPrice), maxPrice: int(rule.maxPrice) } : null,
  };
}

/** Ответ GET …/marketing/sales: payload — массив акций. Незнакомая форма — ошибка, а не пустой список. */
export function parsePromoSales(body: any): PromoSale[] {
  const rows = body?.payload;
  if (!Array.isArray(rows)) throw new Error('marketing/sales: неожиданная форма ответа (нет массива payload)');
  return rows.filter((row) => Number.isFinite(Number(row?.id))).map(parseSale);
}

/** Ответ GET …/marketing/sales/{id}. */
export function parsePromoSale(body: any): PromoSale {
  const row = body?.payload;
  if (!row || !Number.isFinite(Number(row.id))) throw new Error('marketing/sales/{id}: неожиданная форма ответа');
  return parseSale(row);
}

/** Ответ GET …/marketing/sales/{id}/products: плоский список SKU с ценами акции. */
export function parsePromoProducts(saleId: number, body: any): PromoSku[] {
  const products = body?.payload?.content;
  if (!Array.isArray(products)) throw new Error(`marketing/sales/${saleId}/products: неожиданная форма ответа (нет payload.content)`);
  return products.flatMap((product: any) => (Array.isArray(product?.skuList) ? product.skuList : []).map((sku: any) => ({
    saleId,
    productId: Number(product.productId),
    skuId: Number(sku.skuId),
    skuTitle: text(sku.skuTitle),
    availableCount: int(sku.availableCount),
    basePrice: int(sku.currentSellPrice),
    salePrice: int(sku.salePrice),
    maxPrice: int(sku.maxSuitablePrice),
  }))).filter((sku: PromoSku) => Number.isFinite(sku.productId) && Number.isFinite(sku.skuId));
}

/** Постраничный ответ товаров: последняя страница — короче size или помечена last. */
export function isLastPromoPage(body: any, size: number): boolean {
  const payload = body?.payload;
  if (typeof payload?.last === 'boolean') return payload.last;
  if (Number.isFinite(Number(payload?.totalPages)) && Number.isFinite(Number(payload?.number))) return Number(payload.number) + 1 >= Number(payload.totalPages);
  return !Array.isArray(payload?.content) || payload.content.length < size;
}

export type PromoPriceChangeInput = {
  shopExternalId: string;
  sale: Pick<PromoSale, 'id' | 'status' | 'title' | 'priceRule'>;
  skuId: number;
  /** Все SKU акции (достаточно SKU этого товара): кабинет отправляет товар целиком. */
  saleSkus: PromoSku[];
  newPrice: number;
  minPrice?: number | null;
  unitCost?: number | null;
  maxStepPercent?: number;
};

export type SaveSaleProductsBody = {
  products: Array<{ productId: number; skuList: Array<{ skuId: number; newSalePrice: number }> }>;
};

export type PromoPriceChangePlan = {
  allowed: boolean;
  violations: PromoViolation[];
  deltaPercent: number | null;
  floor: number | null;
  sku: PromoSku | null;
  path: string;
  body: SaveSaleProductsBody;
};

export function planPromoPriceChange(input: PromoPriceChangeInput): PromoPriceChangePlan {
  const sku = input.saleSkus.find((row) => row.skuId === input.skuId) ?? null;
  const guards = checkPriceGuards({
    currentPrice: sku?.salePrice ?? null,
    newPrice: input.newPrice,
    minPrice: input.minPrice,
    unitCost: input.unitCost,
    maxStepPercent: input.maxStepPercent,
  });
  const violations: PromoViolation[] = [...(guards.violations as PriceViolation[])];
  const saleName = `«${input.sale.title || input.sale.id}»`;

  if (!sku) violations.push({ code: 'NOT_IN_SALE', message: `SKU ${input.skuId} не участвует в акции ${saleName}` });
  if (!EDITABLE_SALE_STATUSES.includes(input.sale.status)) {
    violations.push({ code: 'SALE_NOT_EDITABLE', message: `Акция ${saleName} в статусе ${input.sale.status || 'неизвестно'} — цену в ней не меняем` });
  }
  if (sku) {
    if (sku.maxPrice === null) violations.push({ code: 'ABOVE_PROMO_LIMIT', message: 'Лимит акции «не более» не получен — без него цену не меняем' });
    else if (input.newPrice > sku.maxPrice) violations.push({ code: 'ABOVE_PROMO_LIMIT', message: `Цена выше лимита акции: не более ${sku.maxPrice}` });
  }
  const rule = input.sale.priceRule;
  if (rule && ((rule.minPrice !== null && input.newPrice < rule.minPrice) || (rule.maxPrice !== null && input.newPrice > rule.maxPrice))) {
    violations.push({ code: 'OUTSIDE_SALE_PRICE_RULE', message: `Цена вне правил акции: от ${rule.minPrice ?? '—'} до ${rule.maxPrice ?? '—'}` });
  }

  // Остальные SKU товара уходят со своими текущими ценами в акции — как делает кабинет.
  const productSkus = sku ? input.saleSkus.filter((row) => row.productId === sku.productId) : [];
  const siblingsWithoutPrice = productSkus.filter((row) => row.skuId !== input.skuId && row.salePrice === null);
  if (siblingsWithoutPrice.length) {
    violations.push({ code: 'CURRENT_PRICE_UNKNOWN', message: `Нет текущей цены в акции у SKU ${siblingsWithoutPrice.map((row) => row.skuId).join(', ')} того же товара` });
  }
  const body: SaveSaleProductsBody = sku
    ? { products: [{ productId: sku.productId, skuList: productSkus.map((row) => ({ skuId: row.skuId, newSalePrice: row.skuId === input.skuId ? input.newPrice : (row.salePrice as number) })) }] }
    : { products: [] };

  return {
    allowed: violations.length === 0,
    violations,
    deltaPercent: guards.deltaPercent,
    floor: guards.floor,
    sku,
    path: `/shop/${input.shopExternalId}/marketing/sales/${input.sale.id}/products`,
    body,
  };
}

/** Текст ошибки внутреннего API; 401 — отдельное понятное сообщение про протухший токен. */
export function promoApiErrorMessage(path: string, status: number, body: any): string {
  if (status === 401) return PROMO_TOKEN_EXPIRED_MESSAGE;
  const detail = body?.message || body?.error || body?.errors?.[0]?.message || body?.errors?.[0]?.detail || body?.errors?.[0]?.code;
  return `${path}: HTTP ${status}${detail ? ` — ${detail}` : ''}`;
}
