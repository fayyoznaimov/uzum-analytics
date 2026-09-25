import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationType, Prisma, SupplyType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { buildFboSupplySummary } from '../../common/fbo-supply-summary';

type QueryValue = string | number | boolean | Array<string | number> | undefined | null;

@Injectable()
export class SuppliesService {
  private readonly base = 'https://api-seller.uzum.uz/api/seller-openapi';
  private readonly logger = new Logger(SuppliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
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

  private async request(path: string, token: string, params?: Record<string, QueryValue>, init?: RequestInit, attempt = 0): Promise<any> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.append(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: token,
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers || {}),
        },
      });
      const raw = await response.text();
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw }; }
      const transient = response.status === 429 || response.status >= 500;
      if (!response.ok && transient && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
        return this.request(path, token, params, init, attempt + 1);
      }
      const apiMessage = body?.message
        || body?.error
        || (Array.isArray(body?.errors)
          ? body.errors.map((item: any) => [item?.code, item?.message].filter(Boolean).join(': ')).filter(Boolean).join('; ')
          : '');
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}${apiMessage ? ` — ${apiMessage}` : ''}`);
      return body;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error(`${path}: превышено время ожидания 25 секунд`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private pickStatus(item: any) {
    const raw = item?.invoiceStatus?.value ?? item?.status?.value ?? item?.status?.code ?? item?.status ?? item?.invoiceStatus ?? item?.state ?? item?.stateCode ?? 'UNKNOWN';
    const label = item?.status?.title ?? item?.status?.text ?? item?.statusLabel ?? item?.stateLabel ?? item?.statusName ?? raw;
    return { status: this.text(raw, 'UNKNOWN').toUpperCase(), statusLabel: this.text(label, this.text(raw, 'UNKNOWN')) };
  }

  private pickSlot(item: any) {
    const reservation = item?.timeSlotReservation ?? item?.timeSlot ?? item?.slot ?? item?.reservation ?? {};
    const from = this.date(reservation?.from ?? reservation?.start ?? reservation?.startAt ?? reservation?.dateFrom ?? item?.slotFrom);
    const to = this.date(reservation?.to ?? reservation?.end ?? reservation?.endAt ?? reservation?.dateTo ?? item?.slotTo);
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

  async sync() {
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
    if (supply.type !== SupplyType.FBS) {
      throw new BadRequestException('Официальный OpenAPI поиска тайм-слотов доступен для FBS. Для FBO сейчас отслеживаются статус и уже назначенный слот.');
    }
    const cfg = await this.integrations.getPlain(IntegrationType.UZUM);
    if (!cfg?.token) throw new BadRequestException('Uzum API token не настроен');
    const details = await this.request(`/v1/fbs/invoice/${supply.externalId}`, cfg.token);
    const orderIds = [...this.collectOrderIds(details)];
    if (!orderIds.length) throw new BadRequestException('В созданной FBS-поставке не удалось определить заказы для поиска слота');
    const point = dropOffPointId || supply.slotWatch?.dropOffPointId || supply.dropOffPointId;
    const result = await this.requestTimeSlots(cfg.token, orderIds, point);
    await this.prisma.supplySlotWatch.upsert({
      where: { supplyId: supply.id },
      update: { dropOffPointId: point || null, lastCheckedAt: new Date(), lastFoundAt: result.slots.length ? new Date() : undefined, lastError: null },
      create: { supplyId: supply.id, dropOffPointId: point || null, lastCheckedAt: new Date(), lastFoundAt: result.slots.length ? new Date() : null, enabled: false },
    });
    if (result.slots.length) {
      const first = result.slots[0];
      const slotKey = first.id || first.from?.toISOString() || 'available';
      const dedupeKey = `slot-found:${supply.id}:${slotKey}`;
      if (!await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) {
        const sent = await this.integrations.notifyTelegram(
          `🟢 Найден тайм-слот для FBS-поставки №${supply.externalId}
${first.from ? first.from.toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' }) : 'Время доступно'}${first.to ? ` — ${first.to.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Tashkent' })}` : ''}`,
          'notifySlotFound',
        ).catch(() => false);
        if (sent) await this.prisma.notificationLog.create({ data: { type: 'SLOT_FOUND', dedupeKey, payload: { supplyId: supply.id, slotKey } } });
      }
    }
    return { supply: { id: supply.id, externalId: supply.externalId }, orderIds, dropOffPointId: point || null, ...result };
  }

  async setWatch(id: string, enabled: boolean, dropOffPointId?: string) {
    const supply = await this.prisma.supply.findUnique({ where: { id } });
    if (!supply) throw new BadRequestException('Поставка не найдена');
    if (supply.type !== SupplyType.FBS) throw new BadRequestException('Автопоиск слота через официальный API доступен только для FBS');
    return this.prisma.supplySlotWatch.upsert({
      where: { supplyId: id },
      update: { enabled, dropOffPointId: dropOffPointId || null, lastError: null },
      create: { supplyId: id, enabled, dropOffPointId: dropOffPointId || null },
    });
  }

  @Cron(process.env.SLOT_WATCH_CRON || '*/5 * * * *')
  async watchSlots() {
    const watches = await this.prisma.supplySlotWatch.findMany({
      where: { enabled: true, supply: { type: SupplyType.FBS } },
      include: { supply: true },
      take: 20,
    });
    for (const watch of watches) {
      try {
        const result = await this.findSlots(watch.supplyId, watch.dropOffPointId || undefined);
        await this.prisma.supplySlotWatch.update({
          where: { id: watch.id },
          data: { lastCheckedAt: new Date(), lastError: null, ...(result.slots.length ? { enabled: false, lastFoundAt: new Date() } : {}) },
        });
      } catch (error: any) {
        await this.prisma.supplySlotWatch.update({ where: { id: watch.id }, data: { lastCheckedAt: new Date(), lastError: error.message } });
      }
    }
  }
}
