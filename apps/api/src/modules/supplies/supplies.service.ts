import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationType, Prisma, SupplyType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { uzumRequest } from '../../common/uzum-http';
import { IntegrationsService } from '../integrations/integrations.service';
import { buildFboSupplySummary } from '../../common/fbo-supply-summary';
import { DesiredWindow, FBO_INVOICE_PATH, FBO_KEEP_UPDATES, FBO_LATE_UPDATE_HOURS, FBO_SLOTS_GET_PATH, FBO_SLOTS_SET_PATH, FboInvoiceState, FboReservation, FboStock, FreeSlot, extensionCovers, fboBookRequest, fboDecide, fboEarlierDay, fboEarliestReservation, fboEarliestStart, fboExtensionTask, fboGroupKey, fboInvoiceState, fboLeadHours, fboReservation, fboSlotsRequest, fboStockOf, formatSlot, formatWindow, parseFboExtensionReport, parseFboSlots, pickSlot } from '../../common/slot-booking';
import { emptyStreak, failureText, markNotified, recordFailure, recordSuccess, recoveryText } from '../../common/failure-alert';
import { PromoPricingService } from '../pricing/promo-pricing.service';

type QueryValue = string | number | boolean | Array<string | number> | undefined | null;
type FboWatch = Prisma.SupplySlotWatchGetPayload<{ include: { supply: { include: { shop: true } } } }>;
type FboGroup = { shopExternalId: string; stock: FboStock; window: DesiredWindow; autoBook: boolean; items: FboWatch[] };

@Injectable()
export class SuppliesService {
  private readonly base = 'https://api-seller.uzum.uz/api/seller-openapi';
  private readonly logger = new Logger(SuppliesService.name);

  /** Сбои проверки FBO-слотов подряд (кабинет за Cloudflare, токен): в Telegram — только затяжные. */
  private fboStreak = emptyStreak();
  /** Последний отчёт Chrome-расширения без ошибки (мс) и сбои его проверок подряд — см. extensionSlotReport. */
  private extensionOkAt: number | null = null;
  private extensionStreak = emptyStreak();

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly promo: PromoPricingService,
  ) {}

  private text(value: any, fallback = '') { return value === null || value === undefined ? fallback : String(value); }
  private num(value: any, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  private date(value: any): Date | null {
    if (!value) return null;
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric) && numeric > 10_000_000_000 ? new Date(numeric) : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  private arrayPayload(data: any, keys: string[]): { rows: any[]; recognized: boolean } {
    for (const key of keys) {
      if (Array.isArray(data?.[key])) return { rows: data[key], recognized: true };
      if (Array.isArray(data?.payload?.[key])) return { rows: data.payload[key], recognized: true };
      if (Array.isArray(data?.data?.[key])) return { rows: data.data[key], recognized: true };
    }
    if (Array.isArray(data?.payload)) return { rows: data.payload, recognized: true };
    if (Array.isArray(data?.data)) return { rows: data.data, recognized: true };
    if (Array.isArray(data)) return { rows: data, recognized: true };
    return { rows: [], recognized: false };
  }

  private arr(data: any, keys: string[]) {
    return this.arrayPayload(data, keys).rows;
  }

  private request(path: string, token: string, params?: Record<string, QueryValue>): Promise<any> {
    return uzumRequest(path, {
      token, params, timeoutMs: 25_000,
      // Два быстрых молчаливых повтора на 429/5xx — ответы Uzum по поставкам флапают.
      retry: { attempts: 2, shouldRetry: (status) => status === 429 || status >= 500, backoffMs: (_s, attempt) => 800 * (attempt + 1), warn: null },
      buildError: (status, body, rawText, requestPath) => {
        const apiMessage = body?.message
          || body?.error
          || (Array.isArray(body?.errors)
            ? body.errors.map((item: any) => [item?.code, item?.message].filter(Boolean).join(': ')).filter(Boolean).join('; ')
            : '')
          || (body?.raw ? String(rawText).slice(0, 500) : '');
        return new Error(`${requestPath}: HTTP ${status}${apiMessage ? ` — ${apiMessage}` : ''}`);
      },
    });
  }

  private pickStatus(item: any) {
    const raw = item?.invoiceStatus?.value ?? item?.status?.value ?? item?.status?.code ?? item?.status ?? item?.invoiceStatus ?? item?.state ?? item?.stateCode ?? 'UNKNOWN';
    const label = item?.status?.title ?? item?.status?.text ?? item?.statusLabel ?? item?.stateLabel ?? item?.statusName ?? raw;
    return { status: this.text(raw, 'UNKNOWN').toUpperCase(), statusLabel: this.text(label, this.text(raw, 'UNKNOWN')) };
  }

  private pickSlot(item: any) {
    const reservation = item?.timeSlotReservation ?? item?.timeSlot ?? item?.slot ?? item?.reservation ?? {};
    const from = this.date(reservation?.timeFrom ?? reservation?.from ?? reservation?.start ?? reservation?.startAt ?? reservation?.dateFrom ?? item?.slotFrom);
    const to = this.date(reservation?.timeTo ?? reservation?.to ?? reservation?.end ?? reservation?.endAt ?? reservation?.dateTo ?? item?.slotTo);
    return { from, to };
  }

  private pickWarehouse(item: any) {
    return this.text(
      item?.warehouseName ?? item?.warehouse?.name ?? item?.dropOffPoint?.name ?? item?.dropOffPointName ?? item?.acceptancePointName,
      '',
    ) || null;
  }

  private supplyId(item: any) {
    return this.text(item?.id ?? item?.invoiceId ?? item?.number ?? item?.invoiceNumber ?? item?.uid);
  }

  private async upsertSupply(shopId: string, type: SupplyType, item: any) {
    const externalId = this.supplyId(item);
    if (!externalId) return { changed: false, created: false, supply: null };
    const { status, statusLabel } = this.pickStatus(item);
    const slot = this.pickSlot(item);
    const existing = await this.prisma.supply.findUnique({
      where: { shopId_type_externalId: { shopId, type, externalId } },
    });
    const data = {
      status,
      statusLabel,
      warehouseName: this.pickWarehouse(item),
      dropOffPointId: this.text(item?.dropOffPointId ?? item?.dropOffPoint?.id, '') || null,
      plannedAt: this.date(item?.plannedAt ?? item?.deliveryDate ?? item?.dateSupply ?? item?.date),
      slotFrom: slot.from,
      slotTo: slot.to,
      itemCount: this.num(item?.itemCount ?? item?.skuCount ?? item?.productsCount ?? item?.items?.length),
      units: this.num(item?.totalAccepted ?? item?.totalToStock ?? item?.units ?? item?.amount ?? item?.quantity ?? item?.totalQuantity),
      raw: item as Prisma.InputJsonValue,
      lastSeenAt: new Date(),
    };
    const supply = await this.prisma.supply.upsert({
      where: { shopId_type_externalId: { shopId, type, externalId } },
      update: data,
      create: { shopId, type, externalId, ...data },
    });
    const changed = Boolean(existing && existing.status !== status);
    if (!existing || changed) {
      await this.prisma.supplyStatusHistory.create({
        data: {
          supplyId: supply.id,
          fromStatus: existing?.status || null,
          toStatus: status,
          raw: item as Prisma.InputJsonValue,
        },
      });
    }
    if (changed) {
      await this.integrations.notifyTelegram(
        `📦 Поставка ${type} №${externalId}\nСтатус изменён: ${existing?.statusLabel || existing?.status || '—'} → ${statusLabel}\n${data.warehouseName ? `Склад: ${data.warehouseName}` : ''}`.trim(),
        'notifySupplyStatus',
      ).catch(() => false);
    }
    return { changed, created: !existing, supply };
  }

  private async syncFbo(shopId: string, externalShopId: string, token: string) {
    let records = 0;
    for (let page = 0; page < 100; page++) {
      const data = await this.request(`/v1/shop/${externalShopId}/invoice`, token, { page, size: 100 });
      const payload = this.arrayPayload(data, ['content', 'invoices', 'items', 'invoiceList']);
      if (!payload.recognized) throw new Error('FBO invoices API returned an unexpected payload');
      const rows = payload.rows;
      if (!rows.length) break;
      for (const item of rows) {
        const result = await this.upsertSupply(shopId, SupplyType.FBO, item);
        if (result.supply) records++;
      }
      const totalPages = this.num(data?.totalPages ?? data?.page?.totalPages);
      if ((totalPages && page >= totalPages - 1) || rows.length < 100) break;
    }
    return records;
  }

  private async syncFbs(shopId: string, _externalShopId: string, token: string) {
    const statuses = ['CREATED', 'ACCEPTANCE_IN_PROGRESS', 'CANCELLED', 'ACCEPTED'];
    let records = 0;
    for (let page = 0; page < 100; page++) {
      // Uzum requires at least one status and caps this endpoint at 20 rows.
      // The seller/shop scope comes from the token; shopId is not a parameter.
      const data = await this.request('/v1/fbs/invoice', token, { page, size: 20, statuses });
      const payload = this.arrayPayload(data, ['content', 'invoices', 'items', 'invoiceList']);
      if (!payload.recognized) throw new Error('FBS invoices API returned an unexpected payload');
      const rows = payload.rows;
      if (!rows.length) break;
      for (const item of rows) {
        const result = await this.upsertSupply(shopId, SupplyType.FBS, item);
        if (result.supply) records++;
      }
      const totalPages = this.num(data?.totalPages ?? data?.page?.totalPages);
      if ((totalPages && page >= totalPages - 1) || rows.length < 20) break;
    }
    return records;
  }

  @Cron(process.env.SUPPLY_SYNC_CRON || '*/10 * * * *')
  async scheduledSync() {
    try { await this.sync(); } catch (error: any) { this.logger.error(`Scheduled supply sync failed: ${error?.message || error}`); }
  }

  // Защита от наложения прогона на самого себя: крон каждые 10 минут, а прогон
  // с ретраями Uzum может идти дольше интервала.
  private supplySyncRunning = false;

  async sync() {
    if (this.supplySyncRunning) throw new BadRequestException('Синхронизация поставок уже выполняется');
    this.supplySyncRunning = true;
    try {
      return await this.syncInner();
    } finally {
      this.supplySyncRunning = false;
    }
  }

  private async syncInner() {
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
    if (!cfg?.token) throw new BadRequestException('Uzum API token не настроен');
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Активный магазин не найден');
    const previousRun = await this.prisma.syncRun.findFirst({
      where: { shopId: shop.id, type: 'SUPPLIES' },
      orderBy: { startedAt: 'desc' },
      select: { status: true, message: true },
    });
    const run = await this.prisma.syncRun.create({ data: { shopId: shop.id, type: 'SUPPLIES', status: 'RUNNING' } });
    const warnings: string[] = [];
    let fbo = 0;
    let fbs = 0;
    try {
      try { fbo = await this.syncFbo(shop.id, shop.externalId, cfg.token); }
      catch (error: any) { warnings.push(`FBO: ${error.message}`); }
      try { fbs = await this.syncFbs(shop.id, shop.externalId, cfg.token); }
      catch (error: any) { warnings.push(`FBS: ${error.message}`); }
      const logistics = warnings.length
        ? 0
        : await this.autoFillLogisticsCosts(shop.id).catch((error: any) => {
          warnings.push(`Логистика поставок: ${error.message}`);
          return 0;
        });
      const status = warnings.length ? 'ERROR' : 'SUCCESS';
      await this.prisma.syncRun.update({
        where: { id: run.id },
        data: { status, records: fbo + fbs, finishedAt: new Date(), message: warnings.join(' | ') || 'Поставки синхронизированы' },
      });
      if (status === 'ERROR') throw new Error(warnings.join(' | '));
      return { ok: true, fbo, fbs, logistics, warnings };
    } catch (error: any) {
      const repeatedUnchangedError = previousRun?.status === 'ERROR' && previousRun.message === error.message;
      if (!repeatedUnchangedError) {
        await this.integrations.notifyTelegram(`⚠️ Ошибка синхронизации поставок\n${error.message}`, 'notifyErrors').catch(() => false);
      }
      throw new BadRequestException(error.message);
    }
  }

  private async autoFillLogisticsCosts(shopId: string) {
    const [supplies, expenses] = await Promise.all([
      this.prisma.supply.findMany({
        where: { shopId, type: SupplyType.FBO, status: 'ACCEPTED' },
        select: { id: true, raw: true, logisticsCost: true },
      }),
      this.prisma.marketplaceExpense.findMany({
        where: { shopId, code: 'У000101', type: 'OUTCOME', amount: { gt: 0 } },
        select: { id: true, amount: true, serviceAt: true },
      }),
    ]);
    const usedExpenses = new Set<string>();
    let matched = 0;
    for (const supply of supplies) {
      const raw = supply.raw as any;
      const acceptedAt = this.date(raw?.dateAccepted);
      if (!acceptedAt) continue;
      const candidates = expenses
        .filter((expense) => !usedExpenses.has(expense.id))
        .map((expense) => ({ expense, distance: Math.abs(expense.serviceAt.getTime() - acceptedAt.getTime()) }))
        .filter((row) => row.distance <= 60_000)
        .sort((a, b) => a.distance - b.distance);
      const expense = candidates.length === 1 ? candidates[0].expense : null;
      if (!expense) continue;
      const marketplaceLogistics = Number(expense.amount);
      if (!Number.isFinite(marketplaceLogistics) || marketplaceLogistics <= 0) continue;
      const current = Number(supply.logisticsCost);
      const desired = marketplaceLogistics;
      // Preserve a custom manual value. Only zero or this exact API expense may be managed automatically.
      if (current !== 0 && current !== desired) continue;
      if (current === desired) {
        usedExpenses.add(expense.id);
        continue;
      }
      await this.syncFboItems(supply.id);
      await this.prisma.supply.update({
        where: { id: supply.id },
        data: { logisticsCost: desired },
      });
      usedExpenses.add(expense.id);
      matched++;
    }
    if (matched) await this.applyAllocatedLogisticsCosts(shopId);
    return matched;
  }

  async list(type?: string, status?: string) {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return [];
    return this.prisma.supply.findMany({
      where: {
        shopId: shop.id,
        ...(type && ['FBO', 'FBS'].includes(type.toUpperCase()) ? { type: type.toUpperCase() as SupplyType } : {}),
        ...(status ? { status: { contains: status, mode: 'insensitive' } } : {}),
      },
      include: { slotWatch: true, history: { take: 5, orderBy: { changedAt: 'desc' } } },
      orderBy: [{ createdAt: 'desc' }, { externalId: 'desc' }],
    });
  }

  private async syncFboItems(supplyId: string) {
    const supply = await this.prisma.supply.findUnique({ where: { id: supplyId }, include: { shop: true } });
    if (!supply || supply.type !== SupplyType.FBO) throw new BadRequestException('FBO-поставка не найдена');
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
    if (!cfg?.token) throw new BadRequestException('Uzum API token не настроен');
    const data = await this.request(`/v1/shop/${supply.shop.externalId}/invoice/products`, cfg.token, { invoiceId: supply.externalId });
    const productPayload = this.arrayPayload(data, ['products', 'items', 'content']);
    if (!productPayload.recognized || !productPayload.rows.length) {
      throw new Error('FBO invoice products API returned an empty or unexpected payload; existing items were preserved');
    }
    const products = productPayload.rows;
    const productRows = products.map((product) => ({
      product,
      skus: this.arrayPayload(product, ['skuForInvoiceDtoList', 'skus', 'items']),
    }));
    if (productRows.some(({ skus }) => !skus.recognized) || !productRows.some(({ skus }) => skus.rows.length)) {
      throw new Error('FBO invoice products API returned no recognizable SKU rows; existing items were preserved');
    }
    const seen: string[] = [];
    let totalUnits = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const { product, skus } of productRows) {
        for (const item of skus.rows) {
          const externalSkuId = this.text(item?.id ?? item?.skuId);
          if (!externalSkuId) continue;
          const plannedQuantity = Math.max(0, Math.round(this.num(item?.quantityToStock ?? item?.quantity)));
          const acceptedQuantity = Math.max(0, Math.round(this.num(item?.quantityAccepted)));
          totalUnits += acceptedQuantity || plannedQuantity;
          let sku = await tx.sku.findFirst({ where: { externalId: externalSkuId, product: { shopId: supply.shopId } } });
          const sourceTitle = this.text(item?.skuTitle ?? product?.productTitle) || null;
          if (!sku && sourceTitle) {
            // Uzum keeps historical SKU ids in old supplies after a SKU was
            // replaced. Match those J471 variants to the current seller SKU so
            // their share of supply delivery is not lost from unit cost.
            const replacementTitle = sourceTitle
              .replace(/-банный$/iu, '-банны')
              .replace(/-лицевой$/iu, '-лицево');
            if (replacementTitle !== sourceTitle) {
              sku = await tx.sku.findFirst({ where: { sellerSku: replacementTitle, product: { shopId: supply.shopId } } });
            }
          }
          await tx.supplyItem.upsert({
            where: { supplyId_externalSkuId: { supplyId, externalSkuId } },
            update: { skuId: sku?.id || null, title: sourceTitle, plannedQuantity, acceptedQuantity, raw: item as Prisma.InputJsonValue },
            create: { supplyId, skuId: sku?.id || null, externalSkuId, title: sourceTitle, plannedQuantity, acceptedQuantity, raw: item as Prisma.InputJsonValue },
          });
          seen.push(externalSkuId);
        }
      }
      if (!seen.length) throw new Error('FBO invoice products contained no valid SKU identifiers; existing items were preserved');
      await tx.supplyItem.deleteMany({ where: { supplyId, externalSkuId: { notIn: seen } } });
      await tx.supply.update({ where: { id: supplyId }, data: { itemCount: seen.length, units: totalUnits } });
    });
  }

  async saveLogisticsCost(id: string, amount: number) {
    const supply = await this.prisma.supply.findUnique({ where: { id } });
    if (!supply) throw new BadRequestException('Поставка не найдена');
    if (supply.type !== SupplyType.FBO) throw new BadRequestException('Распределение доставки сейчас доступно для FBO-поставок');
    await this.syncFboItems(id);
    await this.prisma.supply.update({ where: { id }, data: { logisticsCost: amount } });
    await this.applyAllocatedLogisticsCosts(supply.shopId);
    return this.costing();
  }

  private async applyAllocatedLogisticsCosts(shopId: string) {
    const supplies = await this.prisma.supply.findMany({
      where: { shopId, type: SupplyType.FBO, items: { some: { skuId: { not: null } } } },
      include: { items: true },
    });
    const allocations = new Map<string, { amount: number; units: number }>();
    for (const supply of supplies) {
      const totalUnits = supply.items.reduce((sum, item) => sum + (item.acceptedQuantity || item.plannedQuantity), 0);
      if (!totalUnits) continue;
      for (const item of supply.items) {
        if (!item.skuId) continue;
        const units = item.acceptedQuantity || item.plannedQuantity;
        if (!units) continue;
        const row = allocations.get(item.skuId) || { amount: 0, units: 0 };
        row.amount += Number(supply.logisticsCost) * units / totalUnits;
        row.units += units;
        allocations.set(item.skuId, row);
      }
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const [skuId, allocation] of allocations) {
        const unitCost = allocation.units ? allocation.amount / allocation.units : 0;
        const current = await tx.skuCost.findFirst({ where: { skuId, validTo: null }, orderBy: { validFrom: 'desc' } });
        if (current && Math.abs(Number(current.warehouseLogisticsCost) - unitCost) < 0.01) continue;
        if (current) await tx.skuCost.update({ where: { id: current.id }, data: { validTo: now } });
        await tx.skuCost.create({
          data: {
            skuId,
            amount: Number(current?.amount || 0),
            packagingCost: Number(current?.packagingCost || 0),
            additionalCost: Number(current?.additionalCost || 0),
            warehouseLogisticsCost: unitCost,
            validFrom: now,
            createdBy: 'SUPPLY_ALLOCATION',
          },
        });
      }
    });
  }

  async costing() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return [];
    const supplies = await this.prisma.supply.findMany({
      where: { shopId: shop.id, type: SupplyType.FBO },
      include: { items: { include: { sku: true } } },
      orderBy: [{ plannedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
    });
    return supplies.map((supply) => {
      const units = supply.items.reduce((sum, item) => sum + (item.acceptedQuantity || item.plannedQuantity), 0) || supply.units;
      const amount = Number(supply.logisticsCost);
      return {
        id: supply.id, externalId: supply.externalId, status: supply.status, statusLabel: supply.statusLabel,
        plannedAt: supply.plannedAt, warehouseName: supply.warehouseName, units, itemCount: supply.items.length,
        logisticsCost: amount, costPerUnit: units ? amount / units : 0,
        items: supply.items.map((item) => ({ skuId: item.skuId, externalSkuId: item.externalSkuId, sellerSku: item.sku?.sellerSku, title: item.title, quantity: item.acceptedQuantity || item.plannedQuantity })),
      };
    });
  }

  async formatFboSupplySummary(id: string) {
    const supply = await this.prisma.supply.findUnique({ where: { id } });
    if (!supply || supply.type !== SupplyType.FBO) throw new BadRequestException('FBO-поставка не найдена');
    await this.syncFboItems(id);
    const refreshed = await this.prisma.supply.findUnique({
      where: { id },
      include: { items: { include: { sku: true }, orderBy: { externalSkuId: 'asc' } } },
    });
    if (!refreshed?.items.length) throw new BadRequestException('В документе поставки нет товарных строк');
    const sourceItems = refreshed.items.map((item) => {
      const raw = item.raw && typeof item.raw === 'object' && !Array.isArray(item.raw) ? item.raw as Record<string, unknown> : {};
      return {
        sku: item.sku?.sellerSku || item.title || this.text(raw.skuTitle ?? raw.title) || item.externalSkuId,
        quantity: item.acceptedQuantity || item.plannedQuantity,
      };
    });
    const supplyRaw = refreshed.raw && typeof refreshed.raw === 'object' && !Array.isArray(refreshed.raw) ? refreshed.raw as Record<string, unknown> : {};
    const supplyNumber = this.text(supplyRaw.invoiceNumber ?? supplyRaw.externalNumber) || refreshed.externalId;
    return buildFboSupplySummary(supplyNumber, sourceItems);
  }

  async history(id: string) {
    return this.prisma.supplyStatusHistory.findMany({ where: { supplyId: id }, orderBy: { changedAt: 'desc' } });
  }

  private collectOrderIds(value: any, result = new Set<string>()): Set<string> {
    if (!value || typeof value !== 'object') return result;
    if (Array.isArray(value)) {
      value.forEach((item) => this.collectOrderIds(item, result));
      return result;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      if ((normalized === 'orderid' || normalized === 'order_id') && (typeof item === 'string' || typeof item === 'number')) result.add(String(item));
      if ((normalized === 'orders' || normalized === 'orderlist') && Array.isArray(item)) {
        item.forEach((row: any) => {
          const id = row?.orderId ?? row?.id ?? row?.uid;
          if (id !== undefined && id !== null) result.add(String(id));
        });
      }
      this.collectOrderIds(item, result);
    }
    return result;
  }

  private normalizeSlots(data: any) {
    const rows = this.arr(data, ['timeSlots', 'slots', 'content', 'items']);
    return rows.map((slot: any) => ({
      id: this.text(slot?.id ?? slot?.timeSlotId ?? slot?.uid),
      from: this.date(slot?.from ?? slot?.start ?? slot?.startAt ?? slot?.dateFrom),
      to: this.date(slot?.to ?? slot?.end ?? slot?.endAt ?? slot?.dateTo),
      capacity: this.num(slot?.capacity ?? slot?.remainingCapacity ?? slot?.availableCapacity),
      raw: slot,
    })).filter((slot: any) => slot.id || slot.from || slot.to);
  }

  private async requestTimeSlots(token: string, orderIds: string[], dropOffPointId?: string | null) {
    const attempts: Array<Record<string, QueryValue>> = [
      { orderIds, dropOffPointId },
      { orderIds: orderIds.join(','), dropOffPointId },
      { orders: orderIds.join(','), dropOffPointId },
    ];
    let lastError: any;
    for (const params of attempts) {
      try {
        const data = await this.request('/v1/fbs/invoice/dop/time-slot', token, params);
        const slots = this.normalizeSlots(data);
        if (slots.length || data) return { slots, raw: data };
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('Uzum не вернул тайм-слоты');
  }

  async findSlots(id: string, dropOffPointId?: string) {
    const supply = await this.prisma.supply.findUnique({ where: { id }, include: { shop: true, slotWatch: true } });
    if (!supply) throw new BadRequestException('Поставка не найдена');
    if (supply.type === SupplyType.FBO) return this.findFboSlots(supply);
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
    if (!cfg?.token) throw new BadRequestException('Uzum API token не настроен');
    const details = await this.request(`/v1/fbs/invoice/${supply.externalId}`, cfg.token);
    const orderIds = [...this.collectOrderIds(details)];
    if (!orderIds.length) throw new BadRequestException('В созданной FBS-поставке не удалось определить заказы для поиска слота');
    const point = dropOffPointId || supply.slotWatch?.dropOffPointId || supply.dropOffPointId;
    const result = await this.requestTimeSlots(cfg.token, orderIds, point);
    const window: DesiredWindow = { from: supply.slotWatch?.desiredFrom ?? null, to: supply.slotWatch?.desiredTo ?? null };
    const matched = pickSlot(result.slots as FreeSlot[], window);
    await this.prisma.supplySlotWatch.upsert({
      where: { supplyId: supply.id },
      update: { dropOffPointId: point || null, lastCheckedAt: new Date(), lastFoundAt: matched ? new Date() : undefined, lastError: null },
      create: { supplyId: supply.id, dropOffPointId: point || null, lastCheckedAt: new Date(), lastFoundAt: matched ? new Date() : null, enabled: false },
    });
    // Уведомляем только о слоте, который подходит под желаемую дату; автобронь шлёт своё сообщение сама.
    if (matched && !(supply.slotWatch?.autoBook && this.autoBookEnabled())) {
      const slotKey = matched.id || matched.from?.toISOString() || 'available';
      const dedupeKey = `slot-found:${supply.id}:${slotKey}`;
      if (!await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) {
        const sent = await this.integrations.notifyTelegram(
          `🟢 Найден тайм-слот для FBS-поставки №${supply.externalId}\n${formatSlot(matched)} (желаемая дата: ${formatWindow(window)})${supply.slotWatch?.autoBook ? '\nАвтобронь выключена на сервере (SUPPLY_AUTO_BOOK_APPLY) — забронируйте в кабинете.' : ''}`,
          'notifySlotFound',
        ).catch(() => false);
        if (sent) await this.prisma.notificationLog.create({ data: { type: 'SLOT_FOUND', dedupeKey, payload: { supplyId: supply.id, slotKey } } });
      }
    }
    return { supply: { id: supply.id, externalId: supply.externalId }, orderIds, dropOffPointId: point || null, window, matched, ...result };
  }

  autoBookEnabled() { return process.env.SUPPLY_AUTO_BOOK_APPLY === 'true'; }

  /**
   * Бронь тайм-слота в кабинете через OpenAPI. Запрос задаётся в .env шаблоном SUPPLY_BOOK_SLOT_REQUEST:
   * `METHOD /путь` с подстановками {invoiceId} {slotId} {dropOffPointId}; тело — SUPPLY_BOOK_SLOT_BODY (JSON с теми же
   * подстановками плюс "{orderIds}" — массив, {from} {to} — ISO). Пока не настроен — бронь невозможна, только уведомления.
   */
  private async reserveSlot(token: string, supply: { externalId: string }, orderIds: string[], slot: FreeSlot, dropOffPointId: string | null) {
    const template = process.env.SUPPLY_BOOK_SLOT_REQUEST;
    if (!template) throw new Error('SUPPLY_BOOK_SLOT_REQUEST не задан — эндпоинт брони слота ещё не настроен');
    const sub = (value: string) => value
      .replace(/\{invoiceId\}/g, encodeURIComponent(supply.externalId))
      .replace(/\{slotId\}/g, encodeURIComponent(slot.id || ''))
      .replace(/\{dropOffPointId\}/g, encodeURIComponent(dropOffPointId || ''));
    const [method, path] = template.trim().split(/\s+/, 2);
    let body: unknown;
    if (process.env.SUPPLY_BOOK_SLOT_BODY) {
      const json = sub(process.env.SUPPLY_BOOK_SLOT_BODY)
        .replace(/"\{orderIds\}"/g, JSON.stringify(orderIds))
        .replace(/\{from\}/g, slot.from?.toISOString() ?? '')
        .replace(/\{to\}/g, slot.to?.toISOString() ?? '');
      body = JSON.parse(json);
    }
    return uzumRequest(sub(path || ''), { method: (method || 'POST').toUpperCase() as 'GET' | 'POST' | 'PUT', token, body, timeoutMs: 25_000 });
  }

  async setWatch(id: string, input: { enabled: boolean; dropOffPointId?: string; desiredFrom?: string | null; desiredTo?: string | null; autoBook?: boolean }) {
    const supply = await this.prisma.supply.findUnique({ where: { id } });
    if (!supply) throw new BadRequestException('Поставка не найдена');
    const day = (value?: string | null, end = false) => {
      if (!value) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('Дата задаётся как ГГГГ-ММ-ДД');
      return new Date(`${value}T${end ? '23:59:59' : '00:00:00'}+05:00`);
    };
    const desiredFrom = day(input.desiredFrom);
    const desiredTo = day(input.desiredTo, true);
    if (desiredFrom && desiredTo && desiredFrom > desiredTo) throw new BadRequestException('Дата «с» позже даты «по»');
    const data = { enabled: input.enabled, dropOffPointId: input.dropOffPointId || null, desiredFrom, desiredTo, autoBook: Boolean(input.autoBook), lastError: null, bookError: null };
    return this.prisma.supplySlotWatch.upsert({ where: { supplyId: id }, update: data, create: { supplyId: id, ...data } });
  }

  @Cron(process.env.SLOT_WATCH_CRON || '*/2 * * * *')
  async watchSlots() {
    await this.watchFboSlots().catch((error) => this.logger.warn(`Автобронь FBO: ${error?.message || error}`));
    const watches = await this.prisma.supplySlotWatch.findMany({
      where: { enabled: true, supply: { type: SupplyType.FBS } },
      include: { supply: true },
      take: 20,
    });
    for (const watch of watches) {
      try {
        const result = await this.findSlots(watch.supplyId, watch.dropOffPointId || undefined);
        const matched = result.matched;
        if (!matched) {
          await this.prisma.supplySlotWatch.update({ where: { id: watch.id }, data: { lastCheckedAt: new Date(), lastError: null } });
          continue;
        }
        if (!(watch.autoBook && this.autoBookEnabled())) {
          // Только уведомление (уже отправлено в findSlots) — поиск останавливаем, бронирует владелец.
          await this.prisma.supplySlotWatch.update({ where: { id: watch.id }, data: { lastCheckedAt: new Date(), lastError: null, enabled: false, lastFoundAt: new Date() } });
          continue;
        }
        const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
        if (!cfg?.token) throw new Error('Uzum API token не настроен');
        try {
          const response = await this.reserveSlot(cfg.token, watch.supply, result.orderIds, matched, result.dropOffPointId);
          await this.prisma.supplySlotWatch.update({
            where: { id: watch.id },
            data: { enabled: false, lastCheckedAt: new Date(), lastFoundAt: new Date(), lastError: null, bookError: null, bookedAt: new Date(), bookedSlotFrom: matched.from, bookedSlotTo: matched.to },
          });
          await this.prisma.supply.update({ where: { id: watch.supplyId }, data: { slotFrom: matched.from, slotTo: matched.to, dropOffPointId: result.dropOffPointId ?? undefined } }).catch(() => undefined);
          await this.prisma.notificationLog.create({ data: { type: 'SLOT_BOOKED', dedupeKey: `slot-booked:${watch.supplyId}:${matched.id || matched.from?.toISOString()}`, payload: { supplyId: watch.supplyId, slot: formatSlot(matched), response: response ?? null } as Prisma.InputJsonValue } }).catch(() => undefined);
          await this.integrations.notifyTelegram(`✅ Забронирован тайм-слот для FBS-поставки №${watch.supply.externalId}\n${formatSlot(matched)} (желаемая дата: ${formatWindow(result.window)})`, 'notifySlotFound').catch(() => false);
        } catch (error: any) {
          const message = String(error?.message || error).slice(0, 300);
          await this.prisma.supplySlotWatch.update({ where: { id: watch.id }, data: { lastCheckedAt: new Date(), bookError: message } });
          const dedupeKey = `slot-book-failed:${watch.supplyId}:${message.slice(0, 60)}`;
          if (!await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) {
            const sent = await this.integrations.notifyTelegram(`⚠️ Слот найден (${formatSlot(matched)}), но бронь поставки №${watch.supply.externalId} не прошла: ${message}\nЗабронируйте в кабинете или проверьте настройку брони.`, 'notifySlotFound').catch(() => false);
            if (sent) await this.prisma.notificationLog.create({ data: { type: 'SLOT_BOOK_FAILED', dedupeKey, payload: { supplyId: watch.supplyId } } });
          }
        }
      } catch (error: any) {
        await this.prisma.supplySlotWatch.update({ where: { id: watch.id }, data: { lastCheckedAt: new Date(), lastError: error.message } });
      }
    }
  }

  /** Автобронь FBO включена по умолчанию: эндпоинт подтверждён в кабинете 17.11.2026; SUPPLY_FBO_AUTO_BOOK=false — только уведомления. */
  fboAutoBookEnabled() { return process.env.SUPPLY_FBO_AUTO_BOOK !== 'false'; }

  /** Слот не ближе чем через столько часов (владелец 17.11.2026: «как минимум за 2 дня»). */
  fboLeadHours() { return fboLeadHours(process.env.SUPPLY_FBO_MIN_LEAD_HOURS); }

  private invoiceLabel(supply: { externalId: string; raw: unknown }) {
    return `№${this.text((supply.raw as any)?.invoiceNumber, supply.externalId)}`;
  }

  /** Свободные слоты склада под одну или несколько FBO-накладных (общий привоз) — API кабинета, common/slot-booking.ts. */
  private async fboSlots(shopExternalId: string, invoiceIds: string[], stock: FboStock): Promise<FreeSlot[]> {
    const { body } = await this.promo.cabinet('POST', FBO_SLOTS_GET_PATH(shopExternalId), undefined, fboSlotsRequest(invoiceIds, stock));
    return parseFboSlots(body);
  }

  private async findFboSlots(supply: { id: string; externalId: string; raw: unknown; shop: { externalId: string }; slotWatch: { desiredFrom: Date | null; desiredTo: Date | null } | null }) {
    const stock = fboStockOf(supply.raw);
    if (!stock) throw new BadRequestException('В данных накладной нет склада — обновите поставки и повторите');
    const slots = await this.fboSlots(supply.shop.externalId, [supply.externalId], stock);
    const window: DesiredWindow = { from: supply.slotWatch?.desiredFrom ?? null, to: supply.slotWatch?.desiredTo ?? null };
    const matched = pickSlot(slots, window, fboEarliestStart(new Date(), this.fboLeadHours()));
    if (supply.slotWatch) await this.prisma.supplySlotWatch.update({ where: { supplyId: supply.id }, data: { lastCheckedAt: new Date(), lastFoundAt: matched ? new Date() : undefined, lastError: null } });
    return { supply: { id: supply.id, externalId: supply.externalId }, orderIds: [] as string[], dropOffPointId: null, window, matched, slots, raw: null };
  }

  /**
   * Наблюдения за слотами FBO, сгруппированные по общему привозу: накладные одного склада с одинаковым окном и режимом
   * ищут и бронируют один слот. Накладная, ушедшая из «Создана», снимается с наблюдения; со слотом — тоже, если
   * включено только уведомление. Автобронь со слотом продолжает искать день раньше (fboDecide).
   */
  private async fboWatchGroups(): Promise<Map<string, FboGroup>> {
    const watches = await this.prisma.supplySlotWatch.findMany({
      where: { enabled: true, supply: { type: SupplyType.FBO } },
      include: { supply: { include: { shop: true } } },
      take: 50,
    });
    const groups = new Map<string, FboGroup>();
    for (const watch of watches) {
      const supply = watch.supply;
      const reserved = fboReservation(supply.raw);
      if ((reserved && !watch.autoBook) || supply.status !== 'CREATED') {
        await this.prisma.supplySlotWatch.update({
          where: { id: watch.id },
          data: { enabled: false, lastCheckedAt: new Date(), lastError: supply.status === 'CREATED' ? null : `Накладная в статусе «${supply.statusLabel || supply.status}» — слот больше не нужен` },
        });
        continue;
      }
      const stock = fboStockOf(supply.raw);
      if (!stock) {
        await this.prisma.supplySlotWatch.update({ where: { id: watch.id }, data: { lastCheckedAt: new Date(), lastError: 'В данных накладной нет склада' } });
        continue;
      }
      const window: DesiredWindow = { from: watch.desiredFrom, to: watch.desiredTo };
      const key = `${supply.shop.externalId}|${fboGroupKey(stock, window, watch.autoBook)}`;
      const group: FboGroup = groups.get(key) ?? { shopExternalId: supply.shop.externalId, stock, window, autoBook: watch.autoBook, items: [] };
      group.items.push(watch);
      groups.set(key, group);
    }
    return groups;
  }

  /** Самый ранний слот группы по данным сервера (Supply.raw из синка поставок) — может отставать от кабинета. */
  private fboKnownReservation(group: FboGroup) {
    return fboEarliestReservation(group.items.map((watch) => fboReservation(watch.supply.raw)));
  }

  private fboHead(group: FboGroup) {
    const labels = group.items.map((watch) => this.invoiceLabel(watch.supply)).join(', ');
    return `${group.items.length > 1 ? 'накладных' : 'накладной'} ${labels}`;
  }

  private async fboChecked(group: FboGroup, at: Date = new Date()) {
    await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: group.items.map((w) => w.id) } }, data: { lastCheckedAt: at, lastError: null } });
  }

  /** Брони накладных по кабинету → Supply.slotFrom/slotTo (экран «Поставки» показывает их, не дожидаясь синка). */
  private async fboSaveReservations(group: FboGroup, reservations: Array<{ invoiceId: string; from: Date; to: Date | null }>) {
    for (const item of reservations) {
      const watch = group.items.find((w) => w.supply.externalId === item.invoiceId);
      if (watch) await this.prisma.supply.update({ where: { id: watch.supplyId }, data: { slotFrom: item.from, slotTo: item.to } }).catch(() => undefined);
    }
  }

  private async fboStop(group: FboGroup, reason: string) {
    await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: group.items.map((w) => w.id) } }, data: { enabled: false, lastCheckedAt: new Date(), lastError: reason } });
  }

  /** Режим «только уведомить»: слот найден — сообщение один раз, наблюдение выключается, бронирует владелец. */
  private async fboFound(group: FboGroup, matched: FreeSlot) {
    const ids = group.items.map((watch) => watch.supply.externalId);
    const dedupeKey = `slot-found:fbo:${ids.join(',')}:${matched.id}`;
    if (!await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) {
      const sent = await this.integrations.notifyTelegram(`🟢 Появился тайм-слот для ${this.fboHead(group)}\n${formatSlot(matched)} (желаемая дата: ${formatWindow(group.window)})\nЗабронируйте в кабинете: Поставки → «Выбрать» у накладной.`, 'notifySlotFound').catch(() => false);
      if (sent) await this.prisma.notificationLog.create({ data: { type: 'SLOT_FOUND', dedupeKey, payload: { supplyIds: group.items.map((w) => w.supplyId), slot: formatSlot(matched) } } });
    }
    await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: group.items.map((w) => w.id) } }, data: { enabled: false, lastCheckedAt: new Date(), lastFoundAt: new Date(), lastError: null } });
  }

  /**
   * Слот забронирован или перенесён раньше (previous — прежний слот). Наблюдение остаётся включённым: дальше бот ищет
   * день раньше, пока у накладных есть запасная смена слота и до слота больше 48 ч.
   */
  private async fboBooked(group: FboGroup, matched: FreeSlot, response: unknown, via: string | null, previous: FboReservation | null) {
    const ids = group.items.map((watch) => watch.supply.externalId);
    const now = new Date();
    await this.prisma.supplySlotWatch.updateMany({
      where: { id: { in: group.items.map((w) => w.id) } },
      data: { lastCheckedAt: now, lastFoundAt: now, lastError: null, bookError: null, bookedAt: now, bookedSlotFrom: matched.from, bookedSlotTo: matched.to },
    });
    await this.prisma.supply.updateMany({ where: { id: { in: group.items.map((w) => w.supplyId) } }, data: { slotFrom: matched.from, slotTo: matched.to } });
    await this.prisma.notificationLog.create({ data: { type: previous ? 'SLOT_MOVED' : 'SLOT_BOOKED', dedupeKey: `slot-${previous ? 'moved' : 'booked'}:fbo:${ids.join(',')}:${matched.id}`, payload: { supplyIds: group.items.map((w) => w.supplyId), slot: formatSlot(matched), previous: previous ? formatSlot({ id: '', from: previous.from, to: previous.to, capacity: 0 }) : null, via, response: response ?? null } as Prisma.InputJsonValue } }).catch(() => undefined);
    const text = previous
      ? `↪️ Слот ${this.fboHead(group)} перенесён раньше: ${formatSlot(matched)} вместо ${formatSlot({ id: '', from: previous.from, to: previous.to, capacity: 0 })}`
      : `✅ Забронирован тайм-слот для ${this.fboHead(group)}\n${formatSlot(matched)} (желаемая дата: ${formatWindow(group.window)})\nЕсли освободится день раньше — бот перенесёт.`;
    await this.integrations.notifyTelegram(`${text}${via ? `\nЧерез ${via}.` : ''}`, 'notifySlotFound').catch(() => false);
  }

  private async fboBookFailed(group: FboGroup, matched: FreeSlot, message: string) {
    const ids = group.items.map((watch) => watch.supply.externalId);
    await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: group.items.map((w) => w.id) } }, data: { lastCheckedAt: new Date(), bookError: message } });
    const dedupeKey = `slot-book-failed:fbo:${ids.join(',')}:${message.slice(0, 60)}`;
    if (!await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) {
      const sent = await this.integrations.notifyTelegram(`⚠️ Слот ${formatSlot(matched)} для ${this.fboHead(group)} найден, но бронь не прошла: ${message}\nБот попробует снова через 2 минуты.`, 'notifySlotFound').catch(() => false);
      if (sent) await this.prisma.notificationLog.create({ data: { type: 'SLOT_BOOK_FAILED', dedupeKey, payload: { supplyIds: group.items.map((w) => w.supplyId) } } });
    }
  }

  /** Накладная в кабинете прямо сейчас: статус, бронь и сколько смен слота осталось. */
  private async fboInvoiceStates(group: FboGroup): Promise<FboInvoiceState[]> {
    const states: FboInvoiceState[] = [];
    for (const watch of group.items) {
      const { body } = await this.promo.cabinet('GET', FBO_INVOICE_PATH(group.shopExternalId, watch.supply.externalId));
      states.push(fboInvoiceState(watch.supply.externalId, body));
    }
    return states;
  }

  /**
   * Автобронь слота FBO (владелец 17.11.2026: «бот, который будет чекать постоянно и выбирать таймслот, когда будет
   * доступен»; «если появятся раньше — нужно будет перенести»). Пока Chrome-расширение владельца отчитывается без
   * ошибок (последние 10 минут), сервер кабинет не трогает: из браузера Cloudflare пропускает, а лишние запросы с
   * сервера только продлевают блок.
   */
  private async watchFboSlots() {
    if (extensionCovers(this.extensionOkAt, Date.now())) return;
    const groups = await this.fboWatchGroups();
    for (const group of groups.values()) {
      const ids = group.items.map((watch) => watch.supply.externalId);
      const watchIds = group.items.map((watch) => watch.id);
      const labels = group.items.map((watch) => this.invoiceLabel(watch.supply)).join(', ');
      let slots: FreeSlot[];
      try {
        slots = await this.fboSlots(group.shopExternalId, ids, group.stock);
      } catch (error: any) {
        const message = String(error?.message || error).slice(0, 300);
        await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: watchIds } }, data: { lastCheckedAt: new Date(), lastError: message } });
        const now = Date.now();
        const failure = recordFailure(this.fboStreak, now, { notifyAfter: 15, repeatMs: 6 * 60 * 60_000 });
        this.fboStreak = failure.streak;
        if (failure.notify && await this.integrations.notifyTelegram(failureText(`Автобронь слота (${labels})`, message, failure.streak, now), 'notifySlotFound').catch(() => false)) {
          this.fboStreak = markNotified(this.fboStreak, now);
        }
        continue;
      }
      const success = recordSuccess(this.fboStreak, Date.now());
      this.fboStreak = success.streak;
      if (success.recovered) await this.integrations.notifyTelegram(recoveryText('Автобронь слота', success.failedForMs), 'notifySlotFound').catch(() => undefined);
      // Слоты ближе запаса (2 дня) не берём: товар не успеть собрать и привезти.
      const matched = pickSlot(slots, group.window, fboEarliestStart(new Date(), this.fboLeadHours()));
      if (!(group.autoBook && this.fboAutoBookEnabled())) {
        if (matched) await this.fboFound(group, matched);
        else await this.fboChecked(group);
        continue;
      }
      // По данным сервера слот уже есть и найденный не раньше днём — кабинет лишний раз не спрашиваем.
      const known = this.fboKnownReservation(group);
      if (!matched?.from || (known && !fboEarlierDay(matched.from, known.from))) {
        await this.fboChecked(group);
        continue;
      }
      try {
        // Перед бронью — свежие данные из кабинета: владелец мог выбрать слот сам, а лишняя смена съедает одну из трёх.
        const states = await this.fboInvoiceStates(group);
        await this.fboSaveReservations(group, states.filter((s) => s.reservation).map((s) => ({ invoiceId: s.invoiceId, from: s.reservation!.from, to: s.reservation!.to })));
        const decision = fboDecide(states, matched, new Date());
        if (decision.action === 'stop') { await this.fboStop(group, decision.reason || 'Слот больше не меняем'); continue; }
        if (decision.action === 'wait') { await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: watchIds } }, data: { lastCheckedAt: new Date(), lastError: decision.reason } }); continue; }
        try {
          const { body } = await this.promo.cabinet('POST', FBO_SLOTS_SET_PATH(group.shopExternalId), undefined, fboBookRequest(matched, ids, group.stock));
          await this.fboBooked(group, matched, body, null, decision.action === 'move' ? decision.current : null);
        } catch (error: any) {
          await this.fboBookFailed(group, matched, String(error?.message || error).slice(0, 300));
        }
      } catch (error: any) {
        await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: watchIds } }, data: { lastCheckedAt: new Date(), lastError: String(error?.message || error).slice(0, 300) } });
      }
    }
  }

  // --- Chrome-расширение владельца (эндпоинты competitor-watch, парный токен проверяет CompetitorsService) ---

  /** Задания для расширения: группы накладных, запас до слота и как часто проверять. */
  async extensionSlotTasks() {
    const groups = await this.fboWatchGroups();
    const autoBook = this.fboAutoBookEnabled();
    return {
      leadHours: this.fboLeadHours(),
      lateUpdateHours: FBO_LATE_UPDATE_HOURS,
      keepUpdates: FBO_KEEP_UPDATES,
      intervalMinutes: 2,
      groups: [...groups.entries()].map(([key, group]) => fboExtensionTask(
        key, group.shopExternalId, group.items.map((watch) => watch.supply.externalId),
        group.items.map((watch) => this.invoiceLabel(watch.supply)).join(', '), group.stock, group.window, group.autoBook && autoBook,
        this.fboKnownReservation(group)?.from ?? null,
      )),
    };
  }

  /**
   * Отчёт расширения: проверено / слот найден (режим уведомления) / забронировано / перенесено раньше / бронь не
   * прошла / слот больше не меняем (stop) / ошибка проверки. Ошибки расширения (нет входа в кабинет, браузер не
   * пускают) идут в Telegram после 15 подряд (≈ 30 минут), как у серверного бота.
   */
  async extensionSlotReport(body: unknown) {
    const results = parseFboExtensionReport(body);
    let accepted = 0;
    for (const result of results) {
      const watches = await this.prisma.supplySlotWatch.findMany({
        where: { supply: { type: SupplyType.FBO, externalId: { in: result.invoiceIds } }, ...(result.booked || result.reserved ? {} : { enabled: true }) },
        include: { supply: { include: { shop: true } } },
      });
      if (!watches.length) continue;
      accepted += 1;
      const first = watches[0];
      const stock = fboStockOf(first.supply.raw) ?? { stockId: 0, poolSource: '' };
      const group: FboGroup = { shopExternalId: first.supply.shop.externalId, stock, window: { from: first.desiredFrom, to: first.desiredTo }, autoBook: first.autoBook, items: watches };
      if (result.reservations.length) await this.fboSaveReservations(group, result.reservations);
      if (result.reserved) {
        await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: watches.map((w) => w.id) } }, data: { lastCheckedAt: result.checkedAt, lastError: null } });
        await this.prisma.supply.updateMany({ where: { id: { in: watches.map((w) => w.supplyId) } }, data: { slotFrom: result.reserved.from, slotTo: result.reserved.to } });
        continue;
      }
      if (result.error) {
        await this.prisma.supplySlotWatch.updateMany({ where: { id: { in: watches.map((w) => w.id) } }, data: { lastCheckedAt: result.checkedAt, lastError: `Chrome: ${result.error}` } });
        const now = Date.now();
        const failure = recordFailure(this.extensionStreak, now, { notifyAfter: 15, repeatMs: 6 * 60 * 60_000 });
        this.extensionStreak = failure.streak;
        if (failure.notify && await this.integrations.notifyTelegram(failureText('Проверка слотов из Chrome', result.error, failure.streak, now), 'notifySlotFound').catch(() => false)) {
          this.extensionStreak = markNotified(this.extensionStreak, now);
        }
        continue;
      }
      this.extensionOkAt = Date.now();
      const success = recordSuccess(this.extensionStreak, Date.now());
      this.extensionStreak = success.streak;
      if (success.recovered) await this.integrations.notifyTelegram(recoveryText('Проверка слотов из Chrome', success.failedForMs), 'notifySlotFound').catch(() => undefined);
      if (result.stop) await this.fboStop(group, result.stop);
      else if (result.matched && result.booked) await this.fboBooked(group, result.matched, null, 'Chrome', result.moved ? result.previous : null);
      else if (result.matched && result.bookError) await this.fboBookFailed(group, result.matched, `Chrome: ${result.bookError}`);
      else if (result.matched && !group.autoBook) await this.fboFound(group, result.matched);
      else await this.fboChecked(group, result.checkedAt);
    }
    return { ok: true, accepted };
  }
}
