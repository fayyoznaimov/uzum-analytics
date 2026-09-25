import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationType, Prisma } from '@prisma/client';
import { advertisingRateAt, advertisingRateTimeline, latestAdvertisingRates } from '../../common/advertising';
import { classifyOrderState, resolveOrderReportDate } from '../../common/order-state';
import { basketEligibleDate, scheduledPayoutDate } from '../../common/payout-basket';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

type MoneyPick = { found: boolean; value: number };

/**
 * Эндпоинты, на которых 403/404 от Uzum — это флап, а не отсутствие данных.
 * Продавец существует (в те же минуты те же пути отвечают 200), поэтому такие
 * коды здесь переспрашиваем вместо того, чтобы ронять весь прогон.
 */
const TRANSIENT_ERROR_PATHS = ['/v1/finance/orders', '/v1/finance/expenses'];

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly base = 'https://api-seller.uzum.uz/api/seller-openapi';
  private orderSyncRunning = false;
  constructor(private readonly prisma: PrismaService, private readonly integrations: IntegrationsService) {}

  @Cron(process.env.SYNC_CRON || '*/15 * * * *')
  async scheduled() {
    try { await this.runAll(); }
    catch (error: any) { this.logger.error(`Scheduled sync failed: ${error?.message || error}`); }
  }

  @Cron(process.env.ORDER_NOTIFY_CRON || '*/2 * * * *')
  async scheduledOrders() {
    if (this.orderSyncRunning) return;
    this.orderSyncRunning = true;
    try {
      const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
      if (!cfg?.token) return;
      const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
      if (!shop) return;
      await this.syncOrders(shop.id, shop.externalId, cfg.token);
    } catch (error: any) {
      this.logger.error(`Fast order sync failed: ${error?.message || error}`);
    } finally {
      this.orderSyncRunning = false;
    }
  }

  @Cron(process.env.AD_RATE_REFRESH_CRON || '5 * * * *')
  async refreshAdvertisingRates() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return;
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
    if (!cfg?.token) return;
    // «Процент за продажу» динамический и разный по товарам. Тянем свежие строки
    // finance/expenses каждый час независимо от основной синхронизации, чтобы
    // оценка рекламы за вчера/сегодня всегда бралась по актуальной ставке.
    try {
      await this.syncExpenses(shop.id, shop.externalId, cfg.token);
    } catch (error: any) {
      this.logger.warn(`Advertising rate refresh failed: ${error?.message || error}`);
      return;
    }
    const now = new Date();
    const expenses = await this.prisma.marketplaceExpense.findMany({
      where: {
        shopId: shop.id,
        code: 'У000120',
        type: 'OUTCOME',
        productExternalId: { not: null },
        serviceAt: { gte: new Date(now.getTime() - 30 * 86_400_000), lte: now },
      },
      select: { id: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
    });
    const rates = latestAdvertisingRates(expenses, { now, lookbackDays: 30 });
    const advertisedProducts = new Set<string>(
      (expenses as Array<{ productExternalId?: string | null }>)
        .map((expense) => String(expense.productExternalId ?? ''))
        .filter(Boolean),
    );
    const stale = [...advertisedProducts].filter((id) => !rates.has(id)).length;
    this.logger.log(`Advertising rates refreshed: ${rates.size} product rates from ${expenses.length} У000120 rows, ${stale} advertised products without a rate in 30 days`);
  }

  @Cron(process.env.AD_RATE_DIGEST_CRON || '15 9 * * *')
  async sendDailyAdvertisingRateDigest() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return;
    const now = new Date();
    const expenses = await this.prisma.marketplaceExpense.findMany({
      where: {
        shopId: shop.id,
        code: 'У000120',
        type: 'OUTCOME',
        productExternalId: { not: null },
        serviceAt: { gte: new Date(now.getTime() - 30 * 86_400_000), lte: now },
      },
      select: { id: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
    });
    const rates = latestAdvertisingRates(expenses, { now, lookbackDays: 30 });
    const products = await this.prisma.product.findMany({
      where: { shopId: shop.id },
      select: { externalId: true, title: true },
      orderBy: { title: 'asc' },
    });
    const lines = products.map((product) => {
      const rate = rates.get(product.externalId);
      const title = product.title.replace(/[\r\n]+/g, ' ').trim();
      return rate
        ? `• ${title}: ${rate.percent}% (наблюдалась ${rate.observedAt.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' })})`
        : `• ${title}: ставка не наблюдалась за 30 дней`;
    });
    await this.integrations.notifyTelegram(
      `📣 Ежедневная проверка ставок рекламы — ${shop.name}\n${lines.join('\n')}\n\nСтавки взяты из фактических строк Uzum У000120, без подстановки общего процента.`,
      'notifyDailyDigest',
    );
  }

  private async request(path: string, token: string, params?: Record<string, string | number>, attempt = 0): Promise<any> {
    const url = new URL(this.base + path);
    Object.entries(params || {}).forEach(([key, value]) => url.searchParams.append(key, String(value)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { headers: { Authorization: token, Accept: 'application/json' }, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const transient = [429, 502, 503, 504].includes(response.status)
          || ([403, 404].includes(response.status) && TRANSIENT_ERROR_PATHS.some((prefix) => path.startsWith(prefix)));
        if (attempt < 3 && transient) {
          // После 429 секунды не хватает — лимит Uzum держится дольше.
          const backoffMs = response.status === 429 ? 5_000 * (attempt + 1) : 1_500 * (attempt + 1);
          this.logger.warn(`${path}: HTTP ${response.status}, повтор через ${Math.round(backoffMs / 1000)} с (попытка ${attempt + 1} из 3)`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          return this.request(path, token, params, attempt + 1);
        }
        const detail = body?.message
          || body?.error
          || body?.errors?.[0]?.message
          || body?.payload?.[0]?.msg;
        throw new Error(`${path}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
      }
      return body;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error(`${path}: превышено время ожидания 30 секунд`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private arr(data: any, keys: string[]) {
    for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data)) return data;
    return [];
  }
  private requiredArray(data: any, keys: string[], endpoint: string) {
    for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data)) return data;
    throw new Error(`${endpoint} returned an unrecognized payload; stored data was not replaced`);
  }
  private async requestRequiredArray(
    path: string,
    token: string,
    params: Record<string, string | number>,
    keys: string[],
    attempts = 3,
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const data = await this.request(path, token, params);
        return { data, rows: this.requiredArray(data, keys, path) };
      } catch (error: any) {
        lastError = error;
        const retryableShapeError = String(error?.message || error).includes('returned an unrecognized payload');
        if (!retryableShapeError || attempt >= attempts - 1) throw error;
        this.logger.warn(`${path} returned an unexpected 200 payload; retrying page ${params.page ?? '?'} (${attempt + 1}/${attempts - 1})`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw lastError;
  }
  private text(value: any, fallback = '') { return value === null || value === undefined ? fallback : String(value); }
  private num(value: any, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
  private nullableDate(value: any): Date | null {
    if (value === null || value === undefined || value === '' || value === 0) return null;
    const number = Number(value);
    const parsed = Number.isFinite(number) && number > 10_000_000_000 ? new Date(number) : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  private dateFromTashkentKey(key: string | null): Date | null {
    return key ? new Date(`${key}T12:00:00+05:00`) : null;
  }
  private financialState(canonicalState: string, issuedAt: Date | null, basketEligibleAt: Date | null, returnedUnits: number, quantity: number) {
    if (canonicalState === 'CANCELED') return 'CANCELED';
    if (returnedUnits > 0 && returnedUnits >= quantity) return 'RETURNED_FULL';
    if (returnedUnits > 0) return 'RETURNED_PARTIAL';
    if (!issuedAt) return 'WAITING_ISSUE';
    if (basketEligibleAt && basketEligibleAt.getTime() > Date.now()) return 'RETURN_HOLD';
    return 'AVAILABLE_TO_WITHDRAW';
  }
  private firstMoney(item: any, keys: string[]): MoneyPick {
    for (const key of keys) {
      const raw = key.split('.').reduce((acc: any, part: string) => acc?.[part], item);
      if (raw === null || raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return { found: true, value };
    }
    return { found: false, value: 0 };
  }

  private async notifyOnce(dedupeKey: string, type: string, text: string, option: 'notifyNewOrders' | 'notifyLowStock', parseMode?: 'HTML' | 'MarkdownV2') {
    if (await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) return;
    const sent = await this.integrations.notifyTelegram(text, option, parseMode).catch(() => false);
    if (sent) await this.prisma.notificationLog.create({ data: { dedupeKey, type } }).catch(() => undefined);
  }

  async runAll() {
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
    if (!cfg?.token) throw new BadRequestException('Uzum API token не настроен');
    const run = await this.prisma.syncRun.create({ data: { type: 'FULL', status: 'RUNNING' } });
    try {
      const shopsData = await this.request('/v1/shops', cfg.token);
      const shops = this.requiredArray(shopsData, ['payload', 'data', 'content', 'shops'], '/v1/shops');
      if (!shops.length) throw new Error('/v1/shops returned no recognizable shops; active shop was not changed');
      const wanted = this.text(cfg.metadata.shopId || shops[0]?.id || shops[0]?.shopId).trim();
      if (!wanted) throw new Error('Uzum did not return a Shop ID and no Shop ID is configured');
      let shop: any = null;
      for (const item of shops) {
        const externalId = this.text(item.id ?? item.shopId ?? item.externalId);
        if (!externalId) continue;
        const saved = await this.prisma.shop.upsert({
          where: { externalId },
          update: { name: this.text(item.name ?? item.title, `Магазин ${externalId}`) },
          create: { externalId, name: this.text(item.name ?? item.title, `Магазин ${externalId}`) },
        });
        if (externalId === wanted) shop = saved;
      }
      if (!shop) {
        throw new Error(`Configured Shop ID ${wanted} was not returned by /v1/shops; active shop was not changed`);
      }
      await this.prisma.shop.updateMany({ where: { id: { not: shop.id } }, data: { isActive: false } });
      await this.prisma.shop.update({ where: { id: shop.id }, data: { isActive: true } });

      const productResult = await this.syncProducts(shop.id, shop.externalId, cfg.token);
      while (this.orderSyncRunning) await new Promise((resolve) => setTimeout(resolve, 250));
      this.orderSyncRunning = true;
      const orderResult = await this.syncOrders(shop.id, shop.externalId, cfg.token).finally(() => { this.orderSyncRunning = false; });
      const expenseResult = await this.syncExpenses(shop.id, shop.externalId, cfg.token);
      await this.prisma.syncRun.update({
        where: { id: run.id },
        data: {
          shopId: shop.id,
          status: 'SUCCESS',
          records: productResult.skus + orderResult.rows + expenseResult.rows,
          finishedAt: new Date(),
          message: `Товары: ${productResult.products}, SKU: ${productResult.skus}, заказы: ${orderResult.rows}, расходы: ${expenseResult.rows}`,
        },
      });
      return { ok: true, shop: shop.name, ...productResult, orders: orderResult.rows, expenses: expenseResult.rows, newOrders: orderResult.newOrders };
    } catch (error: any) {
      const message = String(error?.message || error);
      await this.prisma.syncRun.update({ where: { id: run.id }, data: { status: 'ERROR', finishedAt: new Date(), message } });
      await this.integrations.notifyTelegram(`⚠️ Ошибка синхронизации Uzum Analytics\n${message}`, 'notifyErrors').catch(() => false);
      throw new BadRequestException(message);
    }
  }

  async start() {
    await this.prisma.syncRun.updateMany({
      where: { status: 'RUNNING', type: 'FULL', startedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
      data: { status: 'ERROR', finishedAt: new Date(), message: 'Interrupted stale sync run' },
    });
    const running = await this.prisma.syncRun.findFirst({
      where: { status: 'RUNNING', type: 'FULL' },
      orderBy: { startedAt: 'desc' },
    });
    if (running) return { accepted: true, alreadyRunning: true, runId: running.id };

    void this.runAll().catch((error: any) => {
      this.logger.error(`Manual sync failed: ${error?.message || error}`);
    });
    return { accepted: true, alreadyRunning: false };
  }

  private async syncProducts(shopId: string, externalShopId: string, token: string) {
    let productCount = 0;
    let skuCount = 0;
    let paginationComplete = false;
    const pageLimit = Math.max(1, Number(process.env.PRODUCT_SYNC_MAX_PAGES || 100));
    const lowStockThreshold = Math.max(0, Number(process.env.LOW_STOCK_THRESHOLD || 5));
    for (let page = 0; page < pageLimit; page++) {
      const data = await this.request(`/v1/product/shop/${externalShopId}`, token, { page, size: 100 });
      const products = this.requiredArray(data, ['productList', 'content', 'payload', 'data', 'products', 'items'], `/v1/product/shop/${externalShopId}`);
      if (!products.length) { paginationComplete = true; break; }
      for (const item of products) {
        const productId = this.text(item.id ?? item.productId ?? item.cardId ?? item.product?.id);
        if (!productId) continue;
        const product = await this.prisma.product.upsert({
          where: { shopId_externalId: { shopId, externalId: productId } },
          update: {
            title: this.text(item.title ?? item.name ?? item.product?.title, 'Без названия'),
            imageUrl: item.imageUrl ?? item.photo?.url ?? item.photos?.[0]?.url ?? null,
            status: this.text(item.status ?? item.productStatus) || null,
            raw: item as Prisma.InputJsonValue,
          },
          create: {
            shopId,
            externalId: productId,
            title: this.text(item.title ?? item.name ?? item.product?.title, 'Без названия'),
            imageUrl: item.imageUrl ?? item.photo?.url ?? item.photos?.[0]?.url ?? null,
            status: this.text(item.status ?? item.productStatus) || null,
            raw: item as Prisma.InputJsonValue,
          },
        });
        productCount++;
        const skus = this.arr(item, ['skus', 'skuList', 'variants', 'items']);
        for (const skuItem of skus) {
          const skuId = this.text(skuItem.id ?? skuItem.skuId ?? skuItem.sku);
          if (!skuId) continue;
          const sellerSku = this.text(skuItem.sellerSku ?? skuItem.skuFullTitle ?? skuItem.skuTitle ?? skuItem.article) || null;
          const stockPick = this.firstMoney(skuItem, ['quantityActive', 'stock', 'amount', 'quantity', 'availableAmount']);
          const pricePick = this.firstMoney(skuItem, ['price', 'marketPrice', 'discountPrice', 'sellPrice']);
          const existing = await this.prisma.sku.findUnique({ where: { productId_externalId: { productId: product.id, externalId: skuId } } });
          const stock = stockPick.found
            ? Math.max(0, Math.round(stockPick.value))
            : Math.max(0, existing?.stock ?? 0);
          const sku = await this.prisma.sku.upsert({
            where: { productId_externalId: { productId: product.id, externalId: skuId } },
            update: {
              sellerSku,
              barcode: this.text(skuItem.barcode) || null,
              color: this.text(skuItem.color ?? skuItem.characteristics?.color) || null,
              size: this.text(skuItem.size ?? skuItem.characteristics?.size) || null,
              ...(pricePick.found ? { price: pricePick.value } : {}),
              ...(stockPick.found ? { stock } : {}),
              raw: skuItem as Prisma.InputJsonValue,
            },
            create: {
              productId: product.id,
              externalId: skuId,
              sellerSku,
              barcode: this.text(skuItem.barcode) || null,
              color: this.text(skuItem.color ?? skuItem.characteristics?.color) || null,
              size: this.text(skuItem.size ?? skuItem.characteristics?.size) || null,
              price: pricePick.found ? pricePick.value : null,
              stock,
              raw: skuItem as Prisma.InputJsonValue,
            },
          });
          skuCount++;

          const latest = await this.prisma.stockSnapshot.findFirst({ where: { skuId: sku.id }, orderBy: { capturedAt: 'desc' } });
          const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
          if (stockPick.found && (!latest || latest.amount !== stock || latest.capturedAt.getTime() < sixHoursAgo)) {
            await this.prisma.stockSnapshot.create({ data: { skuId: sku.id, amount: stock } });
          }
          if (existing && existing.stock > lowStockThreshold && stock <= lowStockThreshold) {
            await this.notifyOnce(
              `low-stock:${sku.id}:${stock}`,
              'LOW_STOCK',
              `⚠️ Заканчивается товар\n${product.title}\nSKU: ${sellerSku || skuId}\nОстаток: ${stock} шт.`,
              'notifyLowStock',
            );
          }
        }
      }
      const totalPages = this.num(data?.totalPages ?? data?.page?.totalPages, 0);
      if ((totalPages && page >= totalPages - 1) || products.length < 100) { paginationComplete = true; break; }
    }
    if (!paginationComplete) throw new Error(`product pagination exceeded ${pageLimit} pages`);
    return { products: productCount, skus: skuCount };
  }

  private async syncOrders(shopId: string, externalShopId: string, token: string) {
    let rows = 0;
    let newOrders = 0;
    const advertisingRateNow = new Date();
    const [existingOrderCount, settings, recentAdvertisingExpenses] = await Promise.all([
      this.prisma.order.count({ where: { shopId } }),
      this.prisma.financialSettings.findUnique({ where: { shopId } }),
      this.prisma.marketplaceExpense.findMany({
        where: {
          shopId,
          code: 'У000120',
          type: 'OUTCOME',
          productExternalId: { not: null },
          serviceAt: { gte: new Date(advertisingRateNow.getTime() - 30 * 86_400_000), lte: advertisingRateNow },
        },
        select: { id: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
      }),
    ]);
    const hasBaseline = existingOrderCount > 0;
    const productAdvertisingTimeline = advertisingRateTimeline(recentAdvertisingExpenses);
    const holdDays = Number(settings?.payoutDelayDays ?? 10);
    const payoutSchedule = String((settings as any)?.payoutSchedule || 'BIWEEKLY');
    const pageLimit = Math.max(1, Number(process.env.ORDER_SYNC_MAX_PAGES || 200));
    let paginationComplete = false;
    for (let page = 0; page < pageLimit; page++) {
      const { data, rows: orders } = await this.requestRequiredArray(
        '/v1/finance/orders',
        token,
        { page, size: 100, shopIds: externalShopId },
        ['orderItems', 'content', 'payload', 'data', 'orders', 'items'],
      );
      if (!orders.length) { paginationComplete = true; break; }
      for (const item of orders) {
        const itemExternalId = this.text(item.orderItemId ?? item.itemId ?? item.id ?? item.uid ?? item.orderId);
        if (!itemExternalId) continue;
        const existing = await this.prisma.order.findUnique({ where: { shopId_externalId: { shopId, externalId: itemExternalId } } });
        const marketplaceOrderId = this.text(item.orderId ?? item.order?.id ?? item.parentOrderId)
          || existing?.marketplaceOrderId
          || null;
        const quantityPick = this.firstMoney(item, ['quantity', 'amount', 'count', 'amountCount']);
        const returnUnitsPick = this.firstMoney(item, ['amountReturns', 'returns']);
        const rawQuantity = quantityPick.found ? Math.round(quantityPick.value) : (existing?.quantity ?? 1);
        const returnedUnits = Math.max(
          0,
          existing?.returnedUnits ?? 0,
          returnUnitsPick.found ? Math.round(returnUnitsPick.value) : 0,
        );
        const existingQuantity = existing?.quantity || 0;
        const quantity = Math.max(1, rawQuantity, returnedUnits, existingQuantity);
        const unitPricePick = this.firstMoney(item, ['sellPrice', 'price', 'unitPrice', 'skuPrice']);
        const unitSellPrice = unitPricePick.value;
        const grossPick = this.firstMoney(item, ['totalPrice', 'grossRevenue', 'orderAmount', 'saleAmount', 'soldAmount', 'fullPrice']);
        const grossObserved = grossPick.found || unitPricePick.found;
        const grossKnown = grossObserved || Boolean(existing);
        const gross = grossPick.found
          ? grossPick.value
          : unitPricePick.found
            ? unitSellPrice * quantity
            : Number(existing?.grossRevenue ?? 0);
        const logisticsPick = this.firstMoney(item, ['logisticDeliveryFee', 'logistics', 'logisticsAmount', 'logisticsFee', 'deliveryFee', 'deliveryAmount', 'marketplaceLogistics', 'deliveryCost', 'lastMile']);
        const commissionPick = this.firstMoney(item, ['commission', 'commissionAmount', 'commissionSum', 'marketplaceCommission', 'commissionValue', 'fee']);
        const payoutPick = this.firstMoney(item, ['sellerProfit', 'totalForPay', 'sumForPay', 'paidToSeller', 'payout', 'sellerPayout']);
        const withdrawnPick = this.firstMoney(item, ['withdrawnProfit', 'withdrawnAmount']);
        const returnAmountPick = this.firstMoney(item, ['returnAmount', 'returnSum', 'refundAmount']);
        const sourceReturnReason = [item.returnCause, item.cancelReason, item.cancellationReason, item.cancelledReason]
          .map((value) => this.text(value).trim())
          .find((value) => value && !['null', 'undefined', '-'].includes(value.toLowerCase())) || null;
        const sourceReturnComment = [item.comment, item.cancelComment, item.cancellationComment]
          .map((value) => this.text(value).trim())
          .find((value) => value && !['null', 'undefined', '-'].includes(value.toLowerCase())) || null;
        const sourceOrderedAt = this.nullableDate(item.date ?? item.createdAt ?? item.orderDate);
        const sourcePaidAt = this.nullableDate(item.paidAt ?? item.paymentDate);
        const sourceIssuedAt = this.nullableDate(item.dateIssued ?? item.issuedAt ?? item.deliveredAt ?? item.receivedAt);
        const orderedAt = sourceOrderedAt || existing?.orderedAt || null;
        const paidAt = sourcePaidAt || existing?.paidAt || null;
        const issuedAt = sourceIssuedAt || existing?.issuedAt || null;
        const sourceStatus = this.text(item.status).trim() || existing?.status || null;
        let canonicalState = classifyOrderState({
          status: sourceStatus,
          state: item.state ?? existing?.state,
          dateIssued: issuedAt,
          paidAt,
          cancelled: item.cancelled,
          amount: quantity,
          amountReturns: returnedUnits,
        });
        if (canonicalState === 'CANCELED' && marketplaceOrderId) {
          const hasReturnLogistics = await this.prisma.marketplaceExpense.findFirst({
            where: { shopId, orderExternalId: marketplaceOrderId, code: { startsWith: 'return-logistics-' }, type: 'INCOME' },
            select: { id: true },
          });
          if (hasReturnLogistics) canonicalState = 'RETURNED';
        }
        // dateIssued remains the report date for old screens, but the wallet uses issuedAt/basketEligibleAt.
        const dateIssued = resolveOrderReportDate(issuedAt, orderedAt, existing?.dateIssued);
        const eligibleKey = issuedAt ? basketEligibleDate(issuedAt, holdDays) : null;
        const basketEligibleAt = this.dateFromTashkentKey(eligibleKey);
        const scheduledKey = issuedAt ? scheduledPayoutDate(issuedAt, payoutSchedule, holdDays) : null;
        const scheduledPayoutAt = this.dateFromTashkentKey(scheduledKey);
        const financialState = this.financialState(canonicalState, issuedAt, basketEligibleAt, returnedUnits, quantity);
        const order = await this.prisma.order.upsert({
          where: { shopId_externalId: { shopId, externalId: itemExternalId } },
          update: {
            marketplaceOrderId,
            status: sourceStatus,
            state: canonicalState,
            orderedAt,
            paidAt,
            dateIssued,
            issuedAt,
            basketEligibleAt,
            financialState,
            quantity,
            ...(grossObserved ? { grossRevenue: gross } : {}),
            ...(payoutPick.found ? { payout: payoutPick.value, payoutReported: true } : {}),
            ...(commissionPick.found ? { commission: commissionPick.value, commissionReported: true } : {}),
            ...(logisticsPick.found ? { logistics: logisticsPick.value, logisticsReported: true } : {}),
            ...(returnAmountPick.found ? { returnAmount: returnAmountPick.value } : {}),
            returnedUnits,
            ...(withdrawnPick.found ? { apiWithdrawnAmount: withdrawnPick.value } : {}),
            ...(sourceReturnReason ? { returnReason: sourceReturnReason } : {}),
            ...(sourceReturnComment ? { returnComment: sourceReturnComment } : {}),
            raw: item as Prisma.InputJsonValue,
          },
          create: {
            shopId,
            externalId: itemExternalId,
            marketplaceOrderId,
            status: this.text(item.status) || null,
            state: canonicalState,
            orderedAt,
            paidAt,
            dateIssued,
            issuedAt,
            basketEligibleAt,
            financialState,
            quantity,
            grossRevenue: gross,
            payout: payoutPick.value,
            commission: commissionPick.value,
            logistics: logisticsPick.value,
            payoutReported: payoutPick.found,
            commissionReported: commissionPick.found,
            logisticsReported: logisticsPick.found,
            returnAmount: returnAmountPick.value,
            returnedUnits,
            apiWithdrawnAmount: withdrawnPick.value,
            returnReason: sourceReturnReason,
            returnComment: sourceReturnComment,
            raw: item as Prisma.InputJsonValue,
          },
        });

        if (!existing || existing.state !== canonicalState || existing.status !== (this.text(item.status) || null) || (!existing.issuedAt && issuedAt)) {
          await this.prisma.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: existing?.state || existing?.status || null,
              toStatus: canonicalState,
              sourceStatus: this.text(item.status) || null,
              sourceIssuedAt: issuedAt,
              raw: item as Prisma.InputJsonValue,
            },
          }).catch(() => undefined);
        }
        if (issuedAt) {
          const eventPayout = payoutPick.found ? payoutPick.value : Number(order.payout);
          const eventGross = grossObserved ? gross : Number(order.grossRevenue);
          await this.prisma.orderFinancialEvent.upsert({
            where: { orderId_sourceKey: { orderId: order.id, sourceKey: `sale-issued:${issuedAt.toISOString()}` } },
            update: {
              amount: eventPayout,
              grossAmount: eventGross,
              units: quantity,
              happenedAt: issuedAt,
              basketEligibleAt,
              scheduledPayoutAt,
              raw: item as Prisma.InputJsonValue,
            },
            create: {
              orderId: order.id,
              type: 'SALE_ISSUED',
              amount: eventPayout,
              grossAmount: eventGross,
              units: quantity,
              happenedAt: issuedAt,
              basketEligibleAt,
              scheduledPayoutAt,
              sourceKey: `sale-issued:${issuedAt.toISOString()}`,
              note: `Фактическая выдача товара покупателю; начало удержания на ${holdDays} дн. до корзины вывода.`,
              raw: item as Prisma.InputJsonValue,
            },
          }).catch(() => undefined);
        }
        const previousReturns = Math.max(0, existing?.returnedUnits || 0);
        if (canonicalState !== 'CANCELED' && returnedUnits > previousReturns && Boolean(issuedAt || existing?.issuedAt)) {
          const deltaReturns = returnedUnits - previousReturns;
          const returnPayoutBase = payoutPick.value > 0 ? payoutPick.value : Number(existing?.payout || 0);
          const estimatedReturnPayout = quantity > 0 ? returnPayoutBase * deltaReturns / quantity : 0;
          await this.prisma.orderFinancialEvent.upsert({
            where: { orderId_sourceKey: { orderId: order.id, sourceKey: `return-total:${returnedUnits}` } },
            update: {
              amount: -estimatedReturnPayout,
              grossAmount: -(quantity > 0 ? gross * deltaReturns / quantity : 0),
              units: deltaReturns,
              happenedAt: new Date(),
              basketEligibleAt,
              scheduledPayoutAt,
              raw: item as Prisma.InputJsonValue,
            },
            create: {
              orderId: order.id,
              type: 'RETURN_REVERSAL',
              amount: -estimatedReturnPayout,
              grossAmount: -(quantity > 0 ? gross * deltaReturns / quantity : 0),
              units: deltaReturns,
              happenedAt: new Date(),
              basketEligibleAt,
              scheduledPayoutAt,
              sourceKey: `return-total:${returnedUnits}`,
              note: 'Возврат после ранее зафиксированной выдачи. Прогноз корзины и прибыли уменьшается автоматически.',
              raw: item as Prisma.InputJsonValue,
            },
          }).catch(() => undefined);
        }

        const skuExternal = this.text(item.skuId ?? item.sku?.id ?? item.sku);
        const skuTitle = this.text(item.skuTitle ?? item.sellerSku ?? item.productTitle ?? item.title, 'Товар');
        let sku = skuExternal ? await this.prisma.sku.findFirst({
          where: { externalId: skuExternal, product: { shopId } },
          include: { product: { select: { externalId: true } } },
        }) : null;
        if (!sku && skuTitle) sku = await this.prisma.sku.findFirst({
          where: { sellerSku: skuTitle, product: { shopId } },
          include: { product: { select: { externalId: true } } },
        });
        const productExternalIds = [
          sku?.product?.externalId,
          item.product?.id,
          item.product?.externalId,
          item.productExternalId,
          item.productId,
        ].map((value) => this.text(value)).filter((value, index, values) => value && values.indexOf(value) === index);
        const advertisingRate = productExternalIds
          .map((productExternalId) => advertisingRateAt(
            productAdvertisingTimeline,
            productExternalId,
            orderedAt || advertisingRateNow,
          ))
          .find((rate) => rate !== null) ?? null;
        const productExternalId = advertisingRate?.productExternalId || productExternalIds[0] || null;
        const advertisingPercent = advertisingRate?.percent ?? 0;
        const advertising = gross * advertisingPercent / 100;
        const marketplaceProductId = productExternalId;
        await this.prisma.orderItem.upsert({
          where: { orderId_externalId: { orderId: order.id, externalId: itemExternalId } },
          update: {
            ...(sku?.id ? { skuId: sku.id } : {}),
            ...(marketplaceProductId ? { marketplaceProductId } : {}),
            title: skuTitle,
            quantity,
            ...(unitPricePick.found ? { sellPrice: unitSellPrice } : {}),
            ...(grossObserved ? { amount: gross } : {}),
            returns: returnedUnits,
            ...(sourceReturnComment ? { returnComment: sourceReturnComment } : {}),
            raw: item as Prisma.InputJsonValue,
          },
          create: { orderId: order.id, skuId: sku?.id, externalId: itemExternalId, marketplaceProductId, title: skuTitle, quantity, sellPrice: unitSellPrice, amount: gross, returns: returnedUnits, returnComment: sourceReturnComment, raw: item as Prisma.InputJsonValue },
        });
        rows++;

        if (!existing && hasBaseline && canonicalState === 'WAITING') {
          newOrders++;
          const activeCost = sku ? await this.prisma.skuCost.findFirst({
            where: { skuId: sku.id, validTo: null },
            orderBy: { validFrom: 'desc' },
          }) : null;
          const productCost = activeCost
            ? (Number(activeCost.amount) + Number(activeCost.packagingCost) + Number(activeCost.additionalCost) + Number(activeCost.warehouseLogisticsCost)) * quantity
            : 0;
          const tax = gross * Number(settings?.taxPercent ?? 1) / 100;
          const profit = payoutPick.value - productCost - tax - advertising;
          const profitKnown = payoutPick.found && grossKnown && Boolean(activeCost) && Boolean(advertisingRate);
          const upperSku = skuTitle.toUpperCase();
          const family = upperSku.match(/(?:^|[-_])(J\d+|YD|D272)(?:[-_]|$)/)?.[1] || 'UNKNOWN';
          const variant = upperSku.includes('ЛИЦ') ? 'ЛИЦЕВОЕ'
            : upperSku.includes('БАНН') ? 'БАННОЕ'
            : upperSku.includes('САУН') ? 'САУНА'
            : upperSku.includes('КОМПЛ') || upperSku.includes('МИКС') ? 'КОМПЛЕКТ'
            : 'UNKNOWN';
          const money = (value: number) => Math.round(Math.abs(value)).toLocaleString('ru-RU');
          const escapeHtml = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const advertisingLine = advertisingRate
            ? `\n📣 Оценка рекламы по последней наблюдаемой ставке ${advertisingPercent}%: <b>~-${money(advertising)} so'm</b>`
            : `\n📣 Реклама: <b>не рассчитана</b> (ставка этого товара в Uzum не наблюдалась)`;
          const payoutLine = payoutPick.found
            ? `<b>+${money(payoutPick.value)} so'm</b>`
            : '<b>нет факта API</b>';
          const profitLine = profitKnown
            ? `<b>~${profit >= 0 ? '+' : '-'}${money(profit)} so'm</b>`
            : '<b>не рассчитан: нет выплаты, себестоимости, цены или ставки рекламы</b>';
          const orderDate = new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
            hour12: false, timeZone: 'Asia/Tashkent',
          }).format(orderedAt || new Date()).replace(',', '');
          const notification = `🛒 <b>НОВЫЙ ЗАКАЗ UZUM</b>\n━━━━━━━━━━━━━━━━━━━━\n🧾 Заказ: <b>${escapeHtml(marketplaceOrderId || itemExternalId)}</b>\n📦 SKU: <b>${escapeHtml(skuTitle)}</b>\n🏷 Тип: <b>${family} | ${variant}</b>\n🔢 Кол-во: <b>${quantity}</b> шт\n💰 Цена продажи: <b>${money(gross)} so'm</b>\n💵 К выводу: ${payoutLine}\n🏷 Себестоимость: ${activeCost ? `<b>-${money(productCost)} so'm</b>` : '<b>не задана</b>'}${advertisingLine}\n📈 Потенциальный профит: ${profitLine}\n🕒 Дата: ${orderDate}`;
          await this.notifyOnce(
            `order:new:${itemExternalId}`,
            'NEW_ORDER',
            notification,
            'notifyNewOrders',
            'HTML',
          );
        }
        if (existing && existing.state !== 'CANCELED' && canonicalState === 'CANCELED') {
          const activeCost = sku ? await this.prisma.skuCost.findFirst({
            where: { skuId: sku.id, validTo: null },
            orderBy: { validFrom: 'desc' },
          }) : null;
          const productCost = activeCost
            ? (Number(activeCost.amount) + Number(activeCost.packagingCost) + Number(activeCost.additionalCost) + Number(activeCost.warehouseLogisticsCost)) * quantity
            : 0;
          const tax = gross * Number(settings?.taxPercent ?? 1) / 100;
          const previousPayout = Number(existing.payout || 0);
          const sourcePurchasePrice = this.firstMoney(item, ['purchasePrice']).value;
          const estimatedPayout = previousPayout > 0 ? previousPayout : sourcePurchasePrice;
          const estimatedProfit = estimatedPayout - productCost - tax - advertising;
          const cancellationWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          const [skuOrdered, skuCanceled] = sku ? await Promise.all([
            this.prisma.orderItem.aggregate({
              where: { skuId: sku.id, order: { orderedAt: { gte: cancellationWindowStart } } },
              _sum: { quantity: true },
            }),
            this.prisma.orderItem.aggregate({
              where: { skuId: sku.id, order: { orderedAt: { gte: cancellationWindowStart }, state: 'CANCELED' } },
              _sum: { quantity: true },
            }),
          ]) : [null, null];
          const orderedSkuUnits = Number(skuOrdered?._sum.quantity || 0);
          const canceledSkuUnits = Number(skuCanceled?._sum.quantity || 0);
          const cancellationRate = orderedSkuUnits > 0 ? canceledSkuUnits / orderedSkuUnits * 100 : 0;
          const reason = sourceReturnReason || 'Uzum не передал причину';
          const customerComment = sourceReturnComment;
          const money = (value: number) => Math.round(Math.abs(value)).toLocaleString('ru-RU');
          const escapeHtml = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const formatDate = (value: Date) => new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
            hour12: false, timeZone: 'Asia/Tashkent',
          }).format(value).replace(',', '');
          const detectedAt = new Date();
          const orderAgeHours = orderedAt ? Math.max(0, (detectedAt.getTime() - orderedAt.getTime()) / 3_600_000) : 0;
          const orderAge = orderAgeHours >= 24
            ? `${Math.floor(orderAgeHours / 24)} дн. ${Math.floor(orderAgeHours % 24)} ч.`
            : `${Math.floor(orderAgeHours)} ч.`;
          const advertisingLabel = advertisingRate
            ? 'Оценка рекламы по последней наблюдаемой ставке'
            : 'Реклама';
          const estimateKnown = estimatedPayout > 0 && grossKnown && Boolean(activeCost) && Boolean(advertisingRate);
          const estimateLines = estimatedPayout <= 0
            ? `\n💵 Выплата и потенциальный профит: <b>нет исходного прогноза</b>`
            : estimateKnown
              ? `\n💵 Выплата при выкупе: <b>~${money(estimatedPayout)} so'm</b>\n🏷 Себестоимость товара: <b>-${money(productCost)} so'm</b>\n🧾 Налог: <b>-${money(tax)} so'm</b>\n📣 ${advertisingLabel} ${advertisingPercent}%: <b>-${money(advertising)} so'm</b>\n📉 Потенциальный профит не получен: <b>${estimatedProfit >= 0 ? '~' : '~-'}${money(estimatedProfit)} so'm</b>`
              : `\n💵 Выплата при выкупе: <b>~${money(estimatedPayout)} so'm</b>\n📉 Потенциальный профит: <b>не рассчитан — нет цены, себестоимости или наблюдаемой ставки рекламы товара</b>`;
          const skuStatsLine = orderedSkuUnits > 0
            ? `\n📊 Отмены этого SKU за 30 дней: <b>${canceledSkuUnits} из ${orderedSkuUnits} шт. (${cancellationRate.toFixed(1)}%)</b>`
            : '';
          const commentLine = customerComment ? `\n💬 Комментарий покупателя: <b>${escapeHtml(customerComment)}</b>` : '';
          const notification = `❌ <b>ОТКАЗ / ОТМЕНА UZUM</b>\n━━━━━━━━━━━━━━━━━━━━\n🧾 Заказ: <b>${escapeHtml(marketplaceOrderId || itemExternalId)}</b>\n📦 SKU: <b>${escapeHtml(skuTitle)}</b>\n🔢 Кол-во: <b>${quantity}</b> шт.\n📌 Причина: <b>${escapeHtml(reason)}</b>${commentLine}\n💰 Сумма отменённого заказа: <b>${money(gross)} so'm</b>${estimateLines}${skuStatsLine}\n🕒 Создан: ${orderedAt ? formatDate(orderedAt) : 'нет даты'}\n⏱ Возраст при обнаружении отмены: ${orderAge}\nℹ️ Товар не выдан покупателю. Фактическая выплата и прибыль по заказу: <b>0 so'm</b>.`;
          await this.notifyOnce(
            `order:cancel:${itemExternalId}`,
            'ORDER_CANCELED',
            notification,
            'notifyNewOrders',
            'HTML',
          );
        }
      }
      const totalPages = this.num(data?.totalPages ?? data?.page?.totalPages, 0);
      if ((totalPages && page >= totalPages - 1) || orders.length < 100) { paginationComplete = true; break; }
    }
    if (!paginationComplete) throw new Error(`finance/orders pagination exceeded ${pageLimit} pages`);
    return { rows, newOrders };
  }

  private async syncExpenses(shopId: string, externalShopId: string, token: string) {
    let rows = 0;
    const boostLedger = new Map<string, {
      orderExternalId: string;
      productExternalId: string | null;
      amount: number;
    }>();
    const fulfilledByOrder = new Map<string, {
      orderExternalId: string;
      childExternalId: string | null;
      issuedAt: Date;
    }>();
    const returnedByOrder = new Map<string, {
      orderExternalId: string;
      childExternalId: string | null;
      returnedAt: Date;
      sourceStatus: string;
    }>();
    const pageLimit = Math.max(1, Number(process.env.EXPENSE_SYNC_MAX_PAGES || 200));
    let expensesComplete = false;
    for (let page = 0; page < pageLimit; page++) {
      const data = await this.request('/v1/finance/expenses', token, { page, size: 100, shopIds: externalShopId });
      if (!Array.isArray(data?.payload?.payments)) {
        throw new Error(`finance/expenses page ${page} has no payments array; advertising costs were not rebuilt`);
      }
      const payments = data.payload.payments;
      if (!payments.length) {
        expensesComplete = true;
        break;
      }
      for (const item of payments) {
        const externalId = this.text(item.id ?? item.externalId);
        if (!externalId) throw new Error(`finance/expenses page ${page} contains a row without an external ID`);
        const code = this.text(item.code) || null;
        const normalizedCode = (code || '').replace(/^return-/iu, '');
        const expenseType = this.text(item.type).toUpperCase();
        const isRefund = expenseType === 'INCOME' || /^return-/iu.test(code || '');
        const serviceAt = this.nullableDate(item.dateService ?? item.dateCreated);
        if (!serviceAt) throw new Error(`finance/expenses row ${externalId} has no valid service date`);
        const paymentPrice = Number(item.paymentPrice);
        const quantity = Number(item.amount ?? 1);
        if (!Number.isFinite(paymentPrice) || !Number.isFinite(quantity)) {
          throw new Error(`finance/expenses row ${externalId} has invalid money or quantity`);
        }
        const signedAmount = Math.abs(paymentPrice * Math.max(1, quantity)) * (isRefund ? -1 : 1);
        const expenseName = this.text(item.name);
        const adParts = this.text(item.externalId).split('#')[1]?.split('-') || [];
        const isOrderBoost = normalizedCode === 'У000120';
        const isTopBoost = normalizedCode === 'У000119';
        const marketplaceOrderId = expenseName.match(/(?:Buyurtma|Заказ)\s*(?:№|#)?\s*(\d+)/iu)?.[1] || null;
        const productFromName = expenseName.match(/(?:tovar\s+IDsi|ID\s+товара)\D{0,12}(\d+)/iu)?.[1] || null;
        const orderExternalId = marketplaceOrderId || (isOrderBoost ? adParts[0] || null : null);
        const productExternalId = isOrderBoost ? productFromName || adParts[1] || null : null;
        const campaignExternalId = isTopBoost ? adParts[0] || null : null;
        await this.prisma.marketplaceExpense.upsert({
          where: { shopId_externalId: { shopId, externalId } },
          update: { code, source: this.text(item.source) || null, name: this.text(item.name) || null, type: this.text(item.type) || null, amount: signedAmount, serviceAt, orderExternalId, productExternalId, campaignExternalId, raw: item as Prisma.InputJsonValue },
          create: { shopId, externalId, code, source: this.text(item.source) || null, name: this.text(item.name) || null, type: this.text(item.type) || null, amount: signedAmount, serviceAt, orderExternalId, productExternalId, campaignExternalId, raw: item as Prisma.InputJsonValue },
        });
        if (isOrderBoost && orderExternalId) {
          boostLedger.set(externalId, { orderExternalId, productExternalId, amount: signedAmount });
        }
        const rawLinkedOrderId = this.text(item.externalId).split(':').pop()?.trim() || null;
        const transitionKey = rawLinkedOrderId
          ? `child:${rawLinkedOrderId}`
          : marketplaceOrderId
            ? `parent:${marketplaceOrderId}`
            : null;
        if (marketplaceOrderId && transitionKey && code?.startsWith('logistics-') && expenseType === 'OUTCOME') {
          fulfilledByOrder.set(transitionKey, {
            orderExternalId: marketplaceOrderId,
            childExternalId: rawLinkedOrderId,
            issuedAt: serviceAt,
          });
        }
        if (marketplaceOrderId && code?.startsWith('return-logistics-') && expenseType === 'INCOME') {
          if (transitionKey) returnedByOrder.set(transitionKey, {
            orderExternalId: marketplaceOrderId,
            childExternalId: rawLinkedOrderId,
            returnedAt: serviceAt,
            sourceStatus: code,
          });
        }
        rows++;
      }
      const totalPages = this.num(data?.payload?.totalPages ?? data?.totalPages, 0);
      if ((totalPages && page >= totalPages - 1) || payments.length < 100) {
        expensesComplete = true;
        break;
      }
    }
    if (!expensesComplete) {
      throw new Error(`finance/expenses pagination exceeded ${pageLimit} pages; advertising costs were not rebuilt`);
    }
    // Finance orders do not contain advertising fields. Rebuild adCost only
    // from the authoritative expense ledger after all pages were received.
    // A parent marketplace order can contain several item rows. Prefer rows for
    // the expense product and divide each ledger entry only among its candidates.
    const rawProductExternalId = (raw: unknown): string | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const source = raw as Record<string, any>;
      return this.text(
        source.productId
          ?? source.productExternalId
          ?? source.product?.id
          ?? source.product?.externalId
          ?? source.sku?.productId
          ?? source.sku?.product?.id
          ?? source.sku?.product?.externalId,
      ) || null;
    };
    const boostByOrderProduct = new Map<string, {
      orderExternalId: string;
      productExternalId: string | null;
      amount: number;
    }>();
    for (const entry of boostLedger.values()) {
      const key = JSON.stringify([entry.orderExternalId, entry.productExternalId]);
      const current = boostByOrderProduct.get(key);
      boostByOrderProduct.set(key, {
        ...entry,
        amount: (current?.amount ?? 0) + entry.amount,
      });
    }
    const boostByDatabaseOrder = new Map<string, number>();
    for (const { orderExternalId, productExternalId, amount } of boostByOrderProduct.values()) {
      const exact = await this.prisma.order.findUnique({
        where: { shopId_externalId: { shopId, externalId: orderExternalId } },
        select: {
          id: true,
          raw: true,
          items: {
            select: {
              marketplaceProductId: true,
              raw: true,
              sku: { select: { product: { select: { externalId: true } } } },
            },
          },
        },
      });
      if (exact) {
        const exactMatchesProduct = !productExternalId
          || rawProductExternalId(exact.raw) === productExternalId
          || exact.items.some((item) => [
            item.sku?.product.externalId,
            item.marketplaceProductId,
            rawProductExternalId(item.raw),
          ].some((value) => this.text(value) === productExternalId));
        if (exactMatchesProduct) {
          boostByDatabaseOrder.set(exact.id, (boostByDatabaseOrder.get(exact.id) ?? 0) + amount);
        }
        // An exact order ID with a conflicting product is stronger evidence of
        // a bad/partial link than a reason to charge a different product.
        continue;
      }
      const parentRows = await this.prisma.order.findMany({
        where: { shopId, marketplaceOrderId: orderExternalId },
        select: {
          id: true,
          grossRevenue: true,
          raw: true,
          items: {
            select: {
              amount: true,
              marketplaceProductId: true,
              raw: true,
              sku: { select: { product: { select: { externalId: true } } } },
            },
          },
        },
      });
      const itemMatchesProduct = (item: typeof parentRows[number]['items'][number]) => productExternalId && [
        item.sku?.product.externalId,
        item.marketplaceProductId,
        rawProductExternalId(item.raw),
      ].some((value) => this.text(value) === productExternalId);
      const productRows = productExternalId
        ? parentRows.filter((row) => rawProductExternalId(row.raw) === productExternalId || row.items.some(itemMatchesProduct))
        : [];
      // A product-qualified parent expense must never be assigned to a different
      // product just because the matching SKU relation is temporarily missing.
      const candidates = productExternalId ? productRows : parentRows;
      if (!candidates.length) continue;
      const weights = candidates.map((row) => {
        if (productExternalId) {
          const matchingItemAmount = row.items
            .filter(itemMatchesProduct)
            .reduce((sum, item) => sum + Math.max(0, Number(item.amount)), 0);
          if (matchingItemAmount > 0) return matchingItemAmount;
        }
        return Math.max(0, Number(row.grossRevenue));
      });
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      for (const [index, row] of candidates.entries()) {
        const share = totalWeight > 0 ? weights[index] / totalWeight : 1 / candidates.length;
        boostByDatabaseOrder.set(row.id, (boostByDatabaseOrder.get(row.id) ?? 0) + amount * share);
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.order.updateMany({ where: { shopId }, data: { adCost: 0, adCostReported: false } });
      for (const [id, amount] of boostByDatabaseOrder) {
        await tx.order.update({ where: { id }, data: { adCost: amount, adCostReported: true } });
      }
    }, { timeout: 120_000 });
    const resolveTransitionOrder = async (orderExternalId: string, childExternalId: string | null) => {
      if (childExternalId) {
        const exact = await this.prisma.order.findUnique({
          where: { shopId_externalId: { shopId, externalId: childExternalId } },
        });
        if (exact) return exact;
      }
      const parentRows = await this.prisma.order.findMany({
        where: { shopId, marketplaceOrderId: orderExternalId },
        take: 2,
      });
      return parentRows.length === 1 ? parentRows[0] : null;
    };
    for (const [transitionKey, { orderExternalId, childExternalId, issuedAt }] of fulfilledByOrder) {
      if (returnedByOrder.has(transitionKey)) continue;
      const order = await resolveTransitionOrder(orderExternalId, childExternalId);
      if (!order || order.state === 'CANCELED' || order.state === 'RETURNED') continue;
      const eligibleKey = basketEligibleDate(issuedAt, Number((await this.prisma.financialSettings.findUnique({ where: { shopId } }))?.payoutDelayDays ?? 10));
      await this.prisma.order.update({ where: { id: order.id }, data: { state: 'PAID', issuedAt: order.issuedAt || issuedAt, dateIssued: order.issuedAt || issuedAt, paidAt: order.paidAt || issuedAt, basketEligibleAt: this.dateFromTashkentKey(eligibleKey), financialState: 'RETURN_HOLD' } });
    }
    for (const { orderExternalId, childExternalId, returnedAt, sourceStatus } of returnedByOrder.values()) {
      const order = await resolveTransitionOrder(orderExternalId, childExternalId);
      if (!order || order.state === 'RETURNED') continue;
      await this.prisma.order.update({ where: { id: order.id }, data: { state: 'RETURNED', returnedUnits: Math.max(1, order.quantity), financialState: 'RETURNED_FULL' } });
      await this.prisma.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.state, toStatus: 'RETURNED', sourceStatus, sourceIssuedAt: returnedAt } }).catch(() => undefined);
    }
    return { rows };
  }

  runs() {
    return this.prisma.syncRun.findMany({ take: 20, orderBy: { startedAt: 'desc' }, include: { shop: true } });
  }
}
