import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import {
  competitorAlerts,
  hashWatchToken,
  normalizeSnapshot,
  parseUzumProductUrl,
  WATCH_DEFAULTS,
} from '../../common/competitor-watch';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

const PAIRING_TTL_MS = 10 * 60_000;
const SNAPSHOT_MIN_INTERVAL_MS = 30 * 60_000;

@Injectable()
export class CompetitorsService {
  private readonly logger = new Logger(CompetitorsService.name);
  constructor(private readonly prisma: PrismaService, private readonly integrations: IntegrationsService) {}

  private async activeShop() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Активный магазин не найден');
    return shop;
  }

  // --- Управление списком (защищено AuthGuard в контроллере) ---

  async list() {
    const shop = await this.activeShop();
    const rows = await this.prisma.competitorProduct.findMany({
      where: { shopId: shop.id, isActive: true },
      orderBy: { createdAt: 'asc' },
      include: { snapshots: { orderBy: { capturedAt: 'desc' }, take: 60 } },
    });
    const client = await this.prisma.watchClient.findFirst({ where: { revokedAt: null }, orderBy: { lastSeenAt: 'desc' } });
    return {
      extension: { paired: Boolean(client), lastSeenAt: client?.lastSeenAt ?? null },
      competitors: rows.map((row) => {
        const [latest, previous] = row.snapshots;
        return {
          id: row.id,
          externalId: row.externalId,
          title: latest?.raw && typeof latest.raw === 'object' && (latest.raw as any).title ? (latest.raw as any).title : row.title,
          url: row.url || `https://uzum.uz/ru/product/${row.externalId}`,
          note: row.note,
          latest: latest ? {
            capturedAt: latest.capturedAt,
            price: latest.price,
            fullPrice: latest.fullPrice,
            available: latest.available,
            ordersAmount: latest.ordersAmount,
            rating: latest.rating === null ? null : Number(latest.rating),
            reviewsCount: latest.reviewsCount,
          } : null,
          priceDeltaPercent: latest && previous && previous.price > 0 ? (latest.price - previous.price) / previous.price * 100 : null,
          // Классика оценки чужих продаж: дельта счётчика заказов между первым и последним замером.
          ordersDelta: row.snapshots.length >= 2 && latest?.ordersAmount !== null && row.snapshots[row.snapshots.length - 1].ordersAmount !== null
            ? Number(latest!.ordersAmount) - Number(row.snapshots[row.snapshots.length - 1].ordersAmount)
            : null,
          history: [...row.snapshots].reverse().map((snap) => ({ capturedAt: snap.capturedAt, price: snap.price, available: snap.available, ordersAmount: snap.ordersAmount })),
        };
      }),
    };
  }

  async add(url: string, note?: string) {
    const externalId = parseUzumProductUrl(url);
    if (!externalId) throw new BadRequestException('Не удалось распознать ссылку на карточку uzum.uz — вставьте ссылку вида https://uzum.uz/ru/product/…');
    const shop = await this.activeShop();
    const row = await this.prisma.competitorProduct.upsert({
      where: { shopId_externalId: { shopId: shop.id, externalId } },
      update: { isActive: true, url: String(url).slice(0, 500), note: note?.slice(0, 300) ?? undefined },
      create: { shopId: shop.id, externalId, url: String(url).slice(0, 500), note: note?.slice(0, 300) ?? null },
    });
    return { ok: true, id: row.id, externalId };
  }

  async remove(id: string) {
    const shop = await this.activeShop();
    await this.prisma.competitorProduct.updateMany({ where: { id, shopId: shop.id }, data: { isActive: false } });
    return { ok: true };
  }

  async positions() {
    const shop = await this.activeShop();
    const rows = await this.prisma.searchPositionSnapshot.findMany({
      where: { shopId: shop.id, capturedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      orderBy: { capturedAt: 'desc' },
      take: 2_000,
    });
    const byQuery = new Map<string, Array<typeof rows[number]>>();
    for (const row of rows) byQuery.set(row.query, [...(byQuery.get(row.query) ?? []), row]);
    return [...byQuery.entries()].map(([query, list]) => ({
      query,
      latest: { position: list[0].position, page: list[0].page, totalResults: list[0].totalResults, capturedAt: list[0].capturedAt, productExternalId: list[0].productExternalId },
      history: [...list].reverse().map((row) => ({ capturedAt: row.capturedAt, position: row.position })),
    })).sort((a, b) => (a.latest.position ?? 999) - (b.latest.position ?? 999));
  }

  async createPairingCode() {
    const code = String(randomInt(100_000, 999_999));
    await this.prisma.watchPairingCode.create({ data: { codeHash: hashWatchToken(code), expiresAt: new Date(Date.now() + PAIRING_TTL_MS) } });
    return { code, expiresInMinutes: PAIRING_TTL_MS / 60_000 };
  }

  // --- Эндпоинты расширения (без JWT; парный токен) ---

  async pair(code: string) {
    const row = await this.prisma.watchPairingCode.findUnique({ where: { codeHash: hashWatchToken(String(code || '').trim()) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw new UnauthorizedException('Код не подходит или истёк — создайте новый на экране «Конкуренты»');
    await this.prisma.watchPairingCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    const token = randomBytes(32).toString('hex');
    await this.prisma.watchClient.create({ data: { tokenHash: hashWatchToken(token) } });
    return { token };
  }

  private async clientByToken(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Нет токена расширения');
    const client = await this.prisma.watchClient.findUnique({ where: { tokenHash: hashWatchToken(token) } });
    if (!client || client.revokedAt) throw new UnauthorizedException('Токен расширения отозван');
    await this.prisma.watchClient.update({ where: { id: client.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    return client;
  }

  /** Что снимать: карточки конкурентов и поисковые запросы для позиций своих товаров. */
  async targets(token: string | undefined) {
    await this.clientByToken(token);
    const shop = await this.activeShop();
    const competitors = await this.prisma.competitorProduct.findMany({ where: { shopId: shop.id, isActive: true }, select: { externalId: true } });
    const ownProducts = await this.prisma.product.findMany({ where: { shopId: shop.id }, select: { externalId: true } });
    // Запросы для позиций — реальные ключи рекламного бота за 30 дней.
    const keywordRows = await this.prisma.adBotChange.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      select: { query: true },
      distinct: ['query'],
      take: 30,
    });
    return {
      products: competitors.map((row) => row.externalId),
      ownProductIds: ownProducts.map((row) => row.externalId),
      positionQueries: keywordRows.map((row) => row.query).filter(Boolean),
      intervalMinutes: 180,
    };
  }

  async ingest(token: string | undefined, body: any) {
    await this.clientByToken(token);
    const shop = await this.activeShop();
    const products = Array.isArray(body?.products) ? body.products : [];
    const positions = Array.isArray(body?.positions) ? body.positions : [];
    let savedSnapshots = 0;
    const alerts: string[] = [];
    for (const raw of products.slice(0, 200)) {
      const snap = normalizeSnapshot(raw);
      if (!snap) continue;
      const competitor = await this.prisma.competitorProduct.findUnique({ where: { shopId_externalId: { shopId: shop.id, externalId: snap.productId } } });
      if (!competitor || !competitor.isActive) continue;
      const previous = await this.prisma.competitorSnapshot.findFirst({ where: { competitorId: competitor.id }, orderBy: { capturedAt: 'desc' } });
      // Расширение может дёргаться чаще плана — не плодим снапшоты чаще, чем раз в 30 минут.
      if (previous && Date.now() - previous.capturedAt.getTime() < SNAPSHOT_MIN_INTERVAL_MS
        && previous.price === snap.price && (previous.available ?? null) === (snap.available ?? null)) continue;
      await this.prisma.competitorSnapshot.create({
        data: {
          competitorId: competitor.id,
          price: snap.price,
          fullPrice: snap.fullPrice,
          available: snap.available,
          ordersAmount: snap.ordersAmount,
          rating: snap.rating,
          reviewsCount: snap.reviewsCount,
          raw: { title: snap.title ?? competitor.title } as any,
        },
      });
      if (snap.title && snap.title !== competitor.title) await this.prisma.competitorProduct.update({ where: { id: competitor.id }, data: { title: snap.title } });
      savedSnapshots += 1;
      const title = snap.title || competitor.title || competitor.externalId;
      for (const alert of competitorAlerts(title, previous ? { price: previous.price, available: previous.available } : null, { price: snap.price, available: snap.available ?? null }, WATCH_DEFAULTS)) {
        // Один алерт одного типа по карточке в сутки.
        const dedupeKey = `competitor:${competitor.id}:${alert.type}:${new Date().toISOString().slice(0, 10)}`;
        const seen = await this.prisma.notificationLog.findUnique({ where: { dedupeKey } }).catch(() => null);
        if (seen) continue;
        const sent = await this.integrations.notifyTelegram(alert.text, 'notifyAgents').catch(() => false);
        if (sent) await this.prisma.notificationLog.create({ data: { dedupeKey, type: 'COMPETITOR_ALERT' } }).catch(() => undefined);
        alerts.push(alert.text);
      }
    }
    let savedPositions = 0;
    for (const raw of positions.slice(0, 200)) {
      const query = String(raw?.query || '').trim().slice(0, 120);
      const productExternalId = String(raw?.productExternalId || '').trim();
      if (!query || !productExternalId) continue;
      const position = Number.isFinite(Number(raw?.position)) ? Number(raw.position) : null;
      await this.prisma.searchPositionSnapshot.create({
        data: {
          shopId: shop.id, query, productExternalId,
          position,
          page: Number.isFinite(Number(raw?.page)) ? Number(raw.page) : null,
          totalResults: Number.isFinite(Number(raw?.totalResults)) ? Number(raw.totalResults) : null,
        },
      });
      savedPositions += 1;
    }
    this.logger.log(`Монитор конкурентов: снапшотов ${savedSnapshots}, позиций ${savedPositions}, алертов ${alerts.length}`);
    return { ok: true, savedSnapshots, savedPositions, alerts: alerts.length };
  }
}
