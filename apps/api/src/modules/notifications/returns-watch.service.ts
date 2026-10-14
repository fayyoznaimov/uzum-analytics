import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import {
  STUCK_ORDER_STATE,
  WarehouseRow,
  formatWatchMessage,
  pickStuckOrders,
  pickTransitions,
  warehouseEvents,
} from '../../common/returns-watch';
import { IntegrationsService } from '../integrations/integrations.service';
import { PromoPricingService } from '../pricing/promo-pricing.service';

const CABINET = 'https://api-seller.uzum.uz/api/seller';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Слежка за зависшими заказами: заказ висит без выдачи, Uzum в какой-то день
 * молча меняет статус, а товар возвращается на склад отдельно и позже. Оба
 * события приходят без предупреждения, поэтому раз в час сверяем:
 *   — переходы статусов заказов, которые висели дольше порога;
 *   — складские количества SKU из кабинета (возвращено / доступно / брак).
 * Про каждое событие пишем в Telegram один раз (dedupeKey в NotificationLog).
 */
@Injectable()
export class ReturnsWatchService {
  private readonly logger = new Logger(ReturnsWatchService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly cabinet: PromoPricingService,
  ) {}

  private cutoffDays() {
    return Math.max(1, Number(process.env.STUCK_ORDER_WATCH_DAYS || 14));
  }

  @Cron(process.env.RETURNS_WATCH_CRON || '35 * * * *', { name: 'returns-watch', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    if (process.env.RETURNS_WATCH_ENABLED === 'false') return;
    try {
      await this.run();
    } catch (error: any) {
      this.logger.warn(`Слежка за зависшими заказами: ${error?.message || error}`);
    }
  }

  /** Складские количества по SKU из кабинета, сопоставленные с нашими SKU. */
  private async loadWarehouse(shopId: string): Promise<WarehouseRow[]> {
    const skus = await this.prisma.sku.findMany({
      where: { product: { shopId } },
      select: { id: true, externalId: true, sellerSku: true },
    });
    type OurSku = { id: string; externalId: string; sellerSku: string | null };
    const byExternal = new Map<string, OurSku>(skus.map((sku: OurSku) => [String(sku.externalId), sku]));
    const shopExternalId = await this.cabinet.cabinetShopId();
    const rows: WarehouseRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { body } = await this.cabinet.cabinet('GET', `${CABINET}/shop/${shopExternalId}/product/getProducts`, { page, size: PAGE_SIZE });
      const products: any[] = Array.isArray(body?.productList) ? body.productList : [];
      for (const product of products) {
        for (const sku of Array.isArray(product?.skuList) ? product.skuList : []) {
          const ours = byExternal.get(String(sku?.skuId));
          if (!ours) continue;
          rows.push({
            skuId: ours.id,
            sellerSku: ours.sellerSku || String(sku?.skuTitle || ours.externalId),
            available: Math.max(0, Number(sku?.quantityAvailable) || 0),
            returnedTotal: Math.max(0, Number(sku?.quantityReturned) || 0),
            defectedTotal: Math.max(0, Number(sku?.quantityDefected) || 0),
          });
        }
      }
      if (products.length < PAGE_SIZE) break;
    }
    return rows;
  }

  /** Последний снимок по каждому SKU. */
  private async previousWarehouse(skuIds: string[]) {
    const rows = await this.prisma.skuWarehouseSnapshot.findMany({
      where: { skuId: { in: skuIds } },
      orderBy: { capturedAt: 'desc' },
      select: { skuId: true, available: true, returnedTotal: true, defectedTotal: true, capturedAt: true },
    });
    const latest = new Map<string, WarehouseRow>();
    for (const row of rows) {
      if (latest.has(row.skuId)) continue;
      latest.set(row.skuId, { skuId: row.skuId, sellerSku: '', available: row.available, returnedTotal: row.returnedTotal, defectedTotal: row.defectedTotal });
    }
    return latest;
  }

  async run(now = new Date()) {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return { empty: true as const };
    const cutoffDays = this.cutoffDays();
    const cutoffDate = new Date(now.getTime() - cutoffDays * 86_400_000);
    const orderInclude = { items: { include: { sku: { select: { sellerSku: true } } } } } as const;

    const stuckRows = await this.prisma.order.findMany({
      where: { shopId: shop.id, state: STUCK_ORDER_STATE, orderedAt: { lte: cutoffDate } },
      include: orderInclude,
    });
    const stillStuck = pickStuckOrders(stuckRows, { cutoffDays, now });

    // Переходы за две недели: Uzum иногда проставляет статус задним числом.
    const historyRows = await this.prisma.orderStatusHistory.findMany({
      where: {
        changedAt: { gte: new Date(now.getTime() - 14 * 86_400_000) },
        fromStatus: STUCK_ORDER_STATE,
        order: { shopId: shop.id, orderedAt: { lte: cutoffDate } },
      },
      include: { order: { include: orderInclude } },
    });
    const transitions = pickTransitions(historyRows, { cutoffDays, now });

    let warehouse: ReturnType<typeof warehouseEvents> = [];
    let snapshots = 0;
    try {
      const current = await this.loadWarehouse(shop.id);
      if (current.length) {
        const previous = await this.previousWarehouse(current.map((row) => row.skuId));
        warehouse = warehouseEvents(previous, current, now.toISOString());
        // Пишем только изменившиеся SKU: снимок каждый час по всем превратил бы
        // таблицу в журнал без событий.
        const changed = current.filter((row) => {
          const prev = previous.get(row.skuId);
          return !prev || prev.available !== row.available || prev.returnedTotal !== row.returnedTotal || prev.defectedTotal !== row.defectedTotal;
        });
        if (changed.length) {
          await this.prisma.skuWarehouseSnapshot.createMany({
            data: changed.map((row) => ({
              skuId: row.skuId,
              available: row.available,
              returnedTotal: row.returnedTotal,
              defectedTotal: row.defectedTotal,
              capturedAt: now,
            })),
          });
          snapshots = changed.length;
        }
      }
    } catch (error: any) {
      // Кабинет может быть недоступен — заказы всё равно проверяем.
      this.logger.warn(`Склад кабинета не прочитан: ${error?.message || error}`);
    }

    const fresh = { transitions: [] as typeof transitions, warehouse: [] as typeof warehouse };
    for (const event of transitions) {
      const dedupeKey = `stuck-order:${event.number}:${event.to}:${event.historyId}`;
      if (await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) continue;
      fresh.transitions.push(event);
    }
    for (const event of warehouse) {
      const dedupeKey = `return-stock:${event.skuId}:${event.kind}:${event.units}:${event.capturedKey}`;
      if (await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) continue;
      fresh.warehouse.push(event);
    }

    const message = formatWatchMessage({ ...fresh, stillStuck });
    let sent = false;
    if (message) {
      sent = await this.integrations.notifyTelegram(message, 'notifySupplyStatus');
      if (sent) {
        const logs: Prisma.NotificationLogCreateManyInput[] = [
          ...fresh.transitions.map((event) => ({
            type: 'STUCK_ORDER_MOVED',
            dedupeKey: `stuck-order:${event.number}:${event.to}:${event.historyId}`,
            payload: { number: event.number, to: event.to, daysStuck: event.daysStuck, gross: event.gross } as Prisma.InputJsonValue,
          })),
          ...fresh.warehouse.map((event) => ({
            type: 'RETURN_IN_STOCK',
            dedupeKey: `return-stock:${event.skuId}:${event.kind}:${event.units}:${event.capturedKey}`,
            payload: { sellerSku: event.sellerSku, kind: event.kind, units: event.units, available: event.available } as Prisma.InputJsonValue,
          })),
        ];
        if (logs.length) await this.prisma.notificationLog.createMany({ data: logs, skipDuplicates: true });
      }
    }
    return {
      cutoffDays,
      stillStuck: stillStuck.length,
      stuckAmount: stillStuck.reduce((total, row) => total + row.gross, 0),
      transitions: fresh.transitions.length,
      warehouse: fresh.warehouse.length,
      snapshots,
      notified: sent,
      message,
    };
  }
}
