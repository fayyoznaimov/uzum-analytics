import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { IntegrationType, Prisma } from '@prisma/client';
import { DEFAULT_MAX_STEP_PERCENT, planPriceChange } from '../../common/pricing';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

export type SendPriceOptions = {
  /** По умолчанию true: только лог, в Uzum ничего не уходит. */
  dryRun?: boolean;
  minPrice?: number;
  maxStepPercent?: number;
  fullPrice?: number;
  /** Передать skuTitle из Uzum вместе с ценой. */
  withSkuTitle?: boolean;
  allowDuringPromo?: boolean;
  source?: string;
  reason?: string;
};

type LiveSku = {
  productExternalId: string;
  skuExternalId: string;
  title: string;
  skuTitle: string | null;
  price: number | null;
  blocked: boolean;
  archived: boolean;
  inPromo: boolean;
  promoName: string | null;
};

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  private readonly base = 'https://api-seller.uzum.uz/api/seller-openapi';
  constructor(private readonly prisma: PrismaService, private readonly integrations: IntegrationsService) {}

  private async request(method: 'GET' | 'POST', path: string, token: string, params?: Record<string, string | number>, body?: unknown, attempt = 0): Promise<any> {
    const url = new URL(this.base + path);
    Object.entries(params || {}).forEach(([key, value]) => url.searchParams.append(key, String(value)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method,
        headers: { Authorization: token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 500) }; }
      if (!response.ok) {
        // Повторяем только 429: запрос не дошёл до обработки. На 5xx после POST
        // цена могла уже примениться — повтор решает человек, а не цикл.
        if (response.status === 429 && attempt < 3) {
          const backoffMs = 5_000 * (attempt + 1);
          this.logger.warn(`${path}: HTTP 429, повтор через ${Math.round(backoffMs / 1000)} с (попытка ${attempt + 1} из 3)`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          return this.request(method, path, token, params, body, attempt + 1);
        }
        const detail = parsed?.message || parsed?.error || parsed?.errors?.[0]?.message || parsed?.payload?.[0]?.msg;
        const readOnly = response.status === 403 && /read.?only/i.test(String(detail || text));
        // sku-price-001 «Ску нельзя редактировать» пришёл 25.09.2026 на SKU в акции, хотя в кабинете
        // цену в акции менять можно — причина пока не установлена.
        const locked = parsed?.errors?.some((row: any) => row?.code === 'sku-price-001');
        const hint = readOnly
          ? ' (токен Uzum выдан только на чтение — для изменения цен нужен токен с правом записи)'
          : locked ? ' (Uzum запретил менять цену этого SKU — sku-price-001)' : '';
        const error: any = new Error(`${path}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}${hint}`);
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

  private int(value: any): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }

  /** Свежая цена SKU прямо из Uzum: сохранённая в БД может отставать на интервал синхронизации. */
  private async readLiveSku(externalShopId: string, skuExternalId: string, token: string): Promise<LiveSku | null> {
    const pageLimit = Math.max(1, Number(process.env.PRODUCT_SYNC_MAX_PAGES || 100));
    for (let page = 0; page < pageLimit; page++) {
      const data = await this.request('GET', `/v1/product/shop/${externalShopId}`, token, { page, size: 100 });
      const products = ['productList', 'content', 'payload', 'data', 'products', 'items'].map((key) => data?.[key]).find(Array.isArray);
      if (!products) throw new Error(`/v1/product/shop/${externalShopId} returned an unrecognized payload`);
      for (const item of products) {
        const skus = ['skus', 'skuList', 'variants', 'items'].map((key) => item?.[key]).find(Array.isArray) || [];
        const sku = skus.find((row: any) => String(row?.skuId ?? row?.id ?? '') === skuExternalId);
        if (!sku) continue;
        return {
          productExternalId: String(item.productId ?? item.id ?? item.cardId ?? ''),
          skuExternalId,
          title: String(sku.skuFullTitle ?? sku.productTitle ?? item.title ?? ''),
          skuTitle: sku.skuTitle ? String(sku.skuTitle) : null,
          price: this.int(sku.price ?? sku.sellPrice),
          blocked: Boolean(sku.blocked),
          archived: Boolean(sku.archived),
          inPromo: Boolean(sku.specialOffer?.inOffer),
          promoName: sku.specialOffer?.promoName ?? null,
        };
      }
      if (products.length < 100) break;
    }
    return null;
  }

  /** Полная себестоимость единицы из актуальной записи SkuCost (null, если не заведена). */
  async unitCost(skuExternalId: string, shopId: string) {
    const sku = await this.prisma.sku.findFirst({
      where: { externalId: skuExternalId, product: { shopId } },
      include: { costs: { where: { validTo: null }, orderBy: { validFrom: 'desc' }, take: 1 } },
    });
    const row = sku?.costs[0];
    if (!row) return { sku, unitCost: null };
    const total = Number(row.amount) + Number(row.packagingCost) + Number(row.additionalCost) + Number(row.warehouseLogisticsCost);
    return { sku, unitCost: total > 0 ? total : null };
  }

  /** Порог и шаг: явные параметры поверх PRICE_MIN_UZS / PRICE_MAX_STEP_PERCENT из окружения. */
  guardSettings(options: { minPrice?: number; maxStepPercent?: number }) {
    const envMin = Number(process.env.PRICE_MIN_UZS || 0);
    const minPrice = Math.max(options.minPrice ?? 0, Number.isFinite(envMin) ? envMin : 0) || null;
    const envStep = Number(process.env.PRICE_MAX_STEP_PERCENT);
    const maxStepPercent = options.maxStepPercent ?? (Number.isFinite(envStep) && envStep > 0 ? envStep : DEFAULT_MAX_STEP_PERCENT);
    return { minPrice, maxStepPercent };
  }

  /**
   * Изменение цены продажи одного SKU. Себестоимость этот метод Uzum не принимает.
   * Без dryRun: false ничего не отправляет. Каждая попытка пишется в PriceChange.
   */
  async sendPrice(skuId: string, newPrice: number, options: SendPriceOptions = {}) {
    const dryRun = options.dryRun !== false;
    const skuExternalId = String(skuId).trim();
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
    if (!cfg?.token) throw new BadRequestException('Uzum API token не настроен');
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Нет активного магазина — сначала запустите синхронизацию');

    const live = await this.readLiveSku(shop.externalId, skuExternalId, cfg.token);
    if (!live) throw new BadRequestException(`SKU ${skuExternalId} не найден в магазине ${shop.externalId}`);
    const { sku, unitCost } = await this.unitCost(skuExternalId, shop.id);
    const { minPrice, maxStepPercent } = this.guardSettings(options);

    const plan = planPriceChange({
      shopExternalId: shop.externalId,
      productExternalId: live.productExternalId,
      skuExternalId,
      currentPrice: live.price,
      newPrice,
      fullPrice: options.fullPrice ?? null,
      skuTitle: options.withSkuTitle ? live.skuTitle : null,
      minPrice,
      unitCost,
      maxStepPercent,
      blocked: live.blocked,
      archived: live.archived,
      inPromo: live.inPromo,
      promoName: live.promoName,
      allowDuringPromo: options.allowDuringPromo,
    });
    const requestLog = { method: 'POST', url: this.base + plan.path, body: plan.body };
    const summary = {
      dryRun,
      allowed: plan.allowed,
      sku: { skuId: skuExternalId, productId: live.productExternalId, title: live.title, inPromo: live.inPromo, promoName: live.promoName },
      currentPrice: live.price,
      newPrice,
      deltaPercent: plan.deltaPercent === null ? null : Number(plan.deltaPercent.toFixed(2)),
      guards: { minPrice, unitCost, floor: plan.floor, maxStepPercent },
      violations: plan.violations,
      request: requestLog,
    };
    const record = (status: string, extra: { response?: unknown; verifiedPrice?: number | null; error?: string } = {}) => this.prisma.priceChange.create({
      data: {
        shopExternalId: shop.externalId,
        productExternalId: live.productExternalId,
        skuExternalId,
        oldPrice: live.price,
        newPrice,
        fullPrice: options.fullPrice ?? null,
        dryRun,
        status,
        violations: plan.violations.length ? (plan.violations as Prisma.InputJsonValue) : undefined,
        request: requestLog as Prisma.InputJsonValue,
        response: extra.response === undefined ? undefined : (extra.response as Prisma.InputJsonValue),
        verifiedPrice: extra.verifiedPrice ?? null,
        source: options.source || 'manual',
        reason: options.reason || null,
        error: extra.error || null,
      },
    });

    const tag = `SKU ${skuExternalId}: ${live.price ?? '?'} → ${newPrice}`;
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
      response = await this.request('POST', plan.path, cfg.token, undefined, plan.body);
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`${tag} — ошибка: ${message}`);
      await record('ERROR', { response: error?.responseBody, error: message });
      throw new BadRequestException(message);
    }
    // Uzum применяет цену не мгновенно — перечитываем после паузы и фиксируем, что увидели.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = await this.readLiveSku(shop.externalId, skuExternalId, cfg.token).catch(() => null);
    const verifiedPrice = after?.price ?? null;
    if (sku && verifiedPrice !== null) await this.prisma.sku.update({ where: { id: sku.id }, data: { price: verifiedPrice } });
    await record('SENT', { response, verifiedPrice });
    this.logger.log(`${tag} — отправлено, Uzum сейчас показывает ${verifiedPrice ?? 'нет данных'}`);
    return { ...summary, sent: true, response, verifiedPrice };
  }

  async changes(skuId?: string, limit = 50, kind?: string) {
    return this.prisma.priceChange.findMany({
      where: { ...(skuId ? { skuExternalId: skuId } : {}), ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 200),
    });
  }
}
