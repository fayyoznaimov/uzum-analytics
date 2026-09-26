import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { IntegrationStatus, IntegrationType, Prisma } from '@prisma/client';
import {
  EDITABLE_SALE_STATUSES,
  isLastPromoPage,
  parsePromoProducts,
  parsePromoSale,
  parsePromoSales,
  planPromoPriceChange,
  PROMO_TOKEN_EXPIRED_MESSAGE,
  promoApiErrorMessage,
  PromoSale,
  PromoSku,
  UZUM_PROMO_API_BASE,
} from '../../common/promo-pricing';
import { cabinetProductsPageSize, parseCabinetProducts, StockForecast } from '../../common/auto-pricing';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PricingService } from './pricing.service';

export type SendPromoPriceOptions = {
  /** По умолчанию true: только лог, в Uzum ничего не уходит. */
  dryRun?: boolean;
  /** Обязателен, если SKU одновременно в нескольких акциях. */
  saleId?: number;
  minPrice?: number;
  maxStepPercent?: number;
  source?: string;
  reason?: string;
  rule?: string;
  context?: Record<string, unknown>;
};

export type PromoPosition = PromoSku & { saleTitle: string; saleStatus: string; startDate: string | null; finishDate: string | null };

const SALES_PAGE_SIZE = 24;
const SALES_MAX_PAGES = 20;
const PRODUCTS_PAGE_SIZE = 24;
const PRODUCTS_MAX_PAGES = 50;
const CABINET_API_BASE = 'https://api-seller.uzum.uz/api/seller';
const CABINET_PRODUCTS_PAGE_SIZE = 100;
const CABINET_PRODUCTS_MAX_PAGES = 20;

/**
 * Цены в акциях Uzum через внутренний API кабинета (токен интеграции UZUM_INTERNAL).
 * Схема запросов и все проверки — в common/promo-pricing.ts.
 */
@Injectable()
export class PromoPricingService {
  private readonly logger = new Logger(PromoPricingService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly pricing: PricingService,
  ) {}

  private async session() {
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM_INTERNAL);
    if (!cfg?.token) throw new BadRequestException('Токен кабинета Uzum не настроен — добавьте его в Настройки → Отзывы Uzum');
    const shopExternalId = String(cfg.metadata?.shopId || '').trim() || (await this.prisma.shop.findFirst({ where: { isActive: true } }))?.externalId;
    if (!shopExternalId) throw new BadRequestException('Не указан Shop ID для кабинета Uzum и нет активного магазина');
    const shop = await this.prisma.shop.findUnique({ where: { externalId: shopExternalId } });
    return { token: cfg.token.replace(/^Bearer\s+/i, '').trim(), shopExternalId, shopId: shop?.id ?? null };
  }

  private async request(method: 'GET' | 'POST', path: string, token: string, params?: Record<string, string | number>, body?: unknown, attempt = 0): Promise<any> {
    // Абсолютный URL — другие разделы API кабинета (api-seller.uzum.uz) с тем же токеном.
    const url = new URL(/^https:\/\//.test(path) ? path : UZUM_PROMO_API_BASE + path);
    Object.entries(params || {}).forEach(([key, value]) => url.searchParams.append(key, String(value)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Language': 'ru-RU', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 500) }; }
      if (!response.ok) {
        // Как и в PricingService: повторяем только 429, после POST с 5xx решает человек.
        if (response.status === 429 && attempt < 3) {
          const backoffMs = 5_000 * (attempt + 1);
          this.logger.warn(`${path}: HTTP 429, повтор через ${Math.round(backoffMs / 1000)} с (попытка ${attempt + 1} из 3)`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          return this.request(method, path, token, params, body, attempt + 1);
        }
        if (response.status === 401) {
          await this.prisma.integrationCredential.update({
            where: { type: IntegrationType.UZUM_INTERNAL },
            data: { status: IntegrationStatus.ERROR, lastError: PROMO_TOKEN_EXPIRED_MESSAGE },
          }).catch(() => undefined);
          throw new BadRequestException(PROMO_TOKEN_EXPIRED_MESSAGE);
        }
        const error: any = new Error(promoApiErrorMessage(path, response.status, parsed));
        error.responseBody = parsed;
        throw error;
      }
      return parsed;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error(`${path}: превышено время ожидания 30 секунд`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sales(shopExternalId: string, token: string): Promise<PromoSale[]> {
    const all: PromoSale[] = [];
    for (let page = 0; page < SALES_MAX_PAGES; page++) {
      const rows = parsePromoSales(await this.request('GET', `/shop/${shopExternalId}/marketing/sales`, token, { page, size: SALES_PAGE_SIZE, saleType: 'ALL' }));
      all.push(...rows);
      if (rows.length < SALES_PAGE_SIZE) break;
    }
    return all;
  }

  private async saleSkus(shopExternalId: string, saleId: number, token: string): Promise<PromoSku[]> {
    const all: PromoSku[] = [];
    for (let page = 0; page < PRODUCTS_MAX_PAGES; page++) {
      const body = await this.request('GET', `/shop/${shopExternalId}/marketing/sales/${saleId}/products`, token, { page, size: PRODUCTS_PAGE_SIZE });
      all.push(...parsePromoProducts(saleId, body));
      if (isLastPromoPage(body, PRODUCTS_PAGE_SIZE)) break;
    }
    return all;
  }

  /**
   * Цены SKU во всех акциях, где их ещё можно менять (запланированные и действующие):
   * базовая цена, цена в акции, лимит «не более», остаток. Без skuId — все SKU.
   */
  async promoPrices(skuId?: string): Promise<{ shopExternalId: string; positions: PromoPosition[] }> {
    const { token, shopExternalId } = await this.session();
    const sales = (await this.sales(shopExternalId, token)).filter((sale) => EDITABLE_SALE_STATUSES.includes(sale.status) && sale.involvedProductsCount !== 0);
    const positions: PromoPosition[] = [];
    for (const sale of sales) {
      const skus = await this.saleSkus(shopExternalId, sale.id, token);
      for (const sku of skus) {
        if (skuId && String(sku.skuId) !== String(skuId).trim()) continue;
        positions.push({ ...sku, saleTitle: sale.title, saleStatus: sale.status, startDate: sale.startDate, finishDate: sale.finishDate });
      }
    }
    return { shopExternalId, positions };
  }

  /** Shop ID кабинета: из настроек UZUM_INTERNAL или активного магазина. */
  async cabinetShopId(): Promise<string> {
    return (await this.session()).shopExternalId;
  }

  /** Запрос к API кабинета (любой раздел) с токеном UZUM_INTERNAL — для агента по рекламе. */
  async cabinet(method: 'GET' | 'POST', url: string, params?: Record<string, string | number>, body?: unknown): Promise<{ shopExternalId: string; body: any }> {
    const { token, shopExternalId } = await this.session();
    return { shopExternalId, body: await this.request(method, url, token, params, body) };
  }

  /**
   * Запас SKU по данным кабинета: GET api-seller.uzum.uz/api/seller/shop/{shopId}/product/getProducts
   * (skuList[].avgdsales, turnover, forecastOutOfStock). raw — первая страница как есть, для проверки полей.
   */
  async cabinetStock(now = new Date()): Promise<{ shopExternalId: string; forecasts: StockForecast[]; raw: unknown }> {
    const { token, shopExternalId } = await this.session();
    const url = `${CABINET_API_BASE}/shop/${shopExternalId}/product/getProducts`;
    const extra = new URLSearchParams(process.env.AUTO_PRICING_STOCK_QUERY || '');
    const forecasts: StockForecast[] = [];
    let raw: unknown = null;
    for (let page = 0; page < CABINET_PRODUCTS_MAX_PAGES; page++) {
      const params: Record<string, string | number> = { ...Object.fromEntries(extra), page, size: CABINET_PRODUCTS_PAGE_SIZE };
      const body = await this.request('GET', url, token, params);
      if (page === 0) raw = body;
      forecasts.push(...parseCabinetProducts(body, now));
      if (cabinetProductsPageSize(body) < CABINET_PRODUCTS_PAGE_SIZE) break;
    }
    return { shopExternalId, forecasts, raw };
  }

  /**
   * Изменение цены SKU в акции. Без dryRun: false ничего не отправляет.
   * Каждая попытка пишется в PriceChange с kind = PROMO.
   */
  async sendPromoPrice(skuId: string, newPrice: number, options: SendPromoPriceOptions = {}) {
    const dryRun = options.dryRun !== false;
    const skuExternalId = String(skuId).trim();
    const { token, shopExternalId, shopId } = await this.session();

    const { positions } = await this.promoPrices(skuExternalId);
    const candidates = options.saleId ? positions.filter((row) => row.saleId === options.saleId) : positions;
    if (!candidates.length) {
      throw new BadRequestException(options.saleId
        ? `SKU ${skuExternalId} не участвует в акции ${options.saleId}`
        : `SKU ${skuExternalId} не участвует ни в одной запланированной или действующей акции`);
    }
    if (candidates.length > 1) {
      throw new BadRequestException(`SKU ${skuExternalId} в нескольких акциях (${candidates.map((row) => `${row.saleId} «${row.saleTitle}»`).join(', ')}) — укажите saleId`);
    }
    const position = candidates[0];
    const sale = parsePromoSale(await this.request('GET', `/shop/${shopExternalId}/marketing/sales/${position.saleId}`, token));
    const saleSkus = await this.saleSkus(shopExternalId, sale.id, token);
    const { unitCost } = shopId ? await this.pricing.unitCost(skuExternalId, shopId) : { unitCost: null };
    const { minPrice, maxStepPercent } = this.pricing.guardSettings(options);

    const plan = planPromoPriceChange({ shopExternalId, sale, skuId: Number(skuExternalId), saleSkus, newPrice, minPrice, unitCost, maxStepPercent });
    const sku = plan.sku;
    const requestLog = { method: 'POST', url: UZUM_PROMO_API_BASE + plan.path, body: plan.body, saleId: sale.id, saleTitle: sale.title, basePrice: sku?.basePrice ?? null, maxPrice: sku?.maxPrice ?? null };

    // «К выводу» при новой цене — только расчёт, ничего не меняет. Пригодится для маржи.
    let toWithdraw: number | null = null;
    if (sku) {
      const calc = await this.request('POST', `/shop/${shopExternalId}/marketing/sales/${sale.id}/calculate-to-withdraw`, token, undefined, [{ productId: sku.productId, newSalePrice: newPrice, skuId: sku.skuId }]).catch(() => null);
      const row = Array.isArray(calc?.payload) ? calc.payload.find((item: any) => Number(item?.skuId) === sku.skuId) : null;
      toWithdraw = Number.isFinite(Number(row?.toWithdraw)) ? Number(row.toWithdraw) : null;
    }

    const summary = {
      dryRun,
      allowed: plan.allowed,
      sale: { id: sale.id, title: sale.title, status: sale.status, startDate: sale.startDate, finishDate: sale.finishDate, priceRule: sale.priceRule },
      sku: { skuId: skuExternalId, productId: sku?.productId ?? position.productId, skuTitle: sku?.skuTitle ?? position.skuTitle, availableCount: sku?.availableCount ?? null },
      basePrice: sku?.basePrice ?? null,
      currentPrice: sku?.salePrice ?? null,
      newPrice,
      maxPrice: sku?.maxPrice ?? null,
      toWithdraw,
      deltaPercent: plan.deltaPercent === null ? null : Number(plan.deltaPercent.toFixed(2)),
      guards: { minPrice, unitCost, floor: plan.floor, maxStepPercent },
      violations: plan.violations,
      request: requestLog,
    };
    const record = (status: string, extra: { response?: unknown; verifiedPrice?: number | null; error?: string } = {}) => this.prisma.priceChange.create({
      data: {
        kind: 'PROMO',
        shopExternalId,
        productExternalId: String(sku?.productId ?? position.productId),
        skuExternalId,
        oldPrice: sku?.salePrice ?? null,
        newPrice,
        dryRun,
        status,
        violations: plan.violations.length ? (plan.violations as Prisma.InputJsonValue) : undefined,
        request: requestLog as Prisma.InputJsonValue,
        response: extra.response === undefined ? undefined : (extra.response as Prisma.InputJsonValue),
        verifiedPrice: extra.verifiedPrice ?? null,
        source: options.source || 'manual',
        reason: options.reason || null,
        rule: options.rule || null,
        context: options.context ? (options.context as Prisma.InputJsonValue) : undefined,
        error: extra.error || null,
      },
    });

    const tag = `Акция ${sale.id}, SKU ${skuExternalId}: ${sku?.salePrice ?? '?'} → ${newPrice}`;
    if (!plan.allowed) {
      this.logger.warn(`${dryRun ? '[dry-run] ' : ''}${tag} — отказ: ${plan.violations.map((v) => v.code).join(', ')}`);
      await record('REFUSED');
      return { ...summary, sent: false };
    }
    if (dryRun) {
      this.logger.log(`[dry-run] ${tag} — отправил бы POST ${plan.path} ${JSON.stringify(plan.body)}`);
      await record('DRY_RUN');
      return { ...summary, sent: false };
    }

    this.logger.log(`${tag} — отправляю POST ${plan.path} ${JSON.stringify(plan.body)}`);
    let response: unknown;
    try {
      response = await this.request('POST', plan.path, token, undefined, plan.body);
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`${tag} — ошибка: ${message}`);
      await record('ERROR', { response: error?.responseBody, error: message });
      throw new BadRequestException(message);
    }
    // Перечитываем акцию: цена применилась и SKU из акции не выпал.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = await this.saleSkus(shopExternalId, sale.id, token).then((rows) => rows.find((row) => String(row.skuId) === skuExternalId) ?? null).catch(() => undefined);
    const stillInSale = after === undefined ? null : after !== null;
    const verifiedPrice = after?.salePrice ?? null;
    await record('SENT', { response, verifiedPrice, error: stillInSale === false ? 'После отправки SKU не найден в акции' : undefined });
    this.logger.log(`${tag} — отправлено, в акции сейчас ${verifiedPrice ?? 'нет данных'}${stillInSale === false ? ' (SKU пропал из акции!)' : ''}`);
    return { ...summary, sent: true, response, verifiedPrice, stillInSale };
  }
}
