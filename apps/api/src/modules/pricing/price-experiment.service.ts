import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import {
  evaluateExperiment,
  evaluateMarketing,
  excludedExperiment,
  excludedMarketing,
  ExperimentOrderItem,
  experimentReport,
  ExperimentResult,
  ExperimentVerdict,
  FunnelTotals,
  ordersByWindow,
  overlappingRange,
  parseExcludedDays,
  summarizeExperiments,
  VERDICT_LABELS,
  WindowTotals,
} from '../../common/price-experiment';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;

const tashkentDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(date);
const shiftDay = (day: string, days: number) => tashkentDay(new Date(new Date(`${day}T12:00:00+05:00`).getTime() + days * DAY_MS));
const empty = (): FunnelTotals => ({ impressions: 0, views: 0, carts: 0, orders: 0, days: WINDOW_DAYS });

/**
 * Через 7 дней после каждого реального изменения цены сравнивает заказы
 * «до/после» с контролем (SKU того же товара без изменений цены) и
 * записывает вердикт в PriceChange.evaluation. Опыт магазина затем видит
 * ИИ-ревью автоцен и владелец в Telegram. Заказы — из учёта магазина: куб воронки
 * Uzum, из которого они брались раньше, пропал 09–14.10.2026, и с тех пор оценки
 * копились (изменение старше 45 дней из очереди выпадает).
 */
@Injectable()
export class PriceExperimentService {
  private readonly logger = new Logger(PriceExperimentService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Cron(process.env.PRICE_EXPERIMENT_CRON || '20 10 * * *', { name: 'price-experiments', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    try { await this.run({ notify: true }); } catch (error: any) { this.logger.error(`Ценовые эксперименты: ${error?.message || error}`); }
  }

  async run(options: { notify: boolean }) {
    if (this.running) return { evaluated: 0, messages: [] as string[] };
    this.running = true;
    try {
      const now = new Date();
      const today = tashkentDay(now);
      const due = await this.prisma.priceChange.findMany({
        where: {
          status: 'SENT', dryRun: false, evaluatedAt: null,
          createdAt: { gte: new Date(now.getTime() - 45 * DAY_MS), lte: new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS) },
        },
        orderBy: { createdAt: 'asc' },
      });

      // Эксперимент = товар + день + направление: все SKU, сдвинутые в этот день одинаково.
      const groups = new Map<string, typeof due>();
      for (const row of due) {
        if (row.oldPrice === null || row.oldPrice === row.newPrice) continue;
        const key = `${row.productExternalId}|${tashkentDay(row.createdAt)}|${row.newPrice > row.oldPrice ? 'up' : 'down'}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }

      const lines: string[] = [];
      let evaluated = 0;
      const excludedDays = parseExcludedDays(process.env.PRICE_EXPERIMENT_EXCLUDE_DAYS);
      for (const [key, rows] of groups) {
        const [productId, day] = key.split('|');
        const from = shiftDay(day, -WINDOW_DAYS);
        const to = shiftDay(day, WINDOW_DAYS);
        if (to >= today) continue;
        const priceChangePercent = rows.reduce((sumPct, row) => sumPct + (row.newPrice - (row.oldPrice as number)) / (row.oldPrice as number) * 100, 0) / rows.length;
        const changedSkus = new Set(rows.map((row) => row.skuExternalId));
        const excluded = overlappingRange(from, to, excludedDays);
        if (excluded) {
          // Самовыкупы и ручная смена цен в окне: вывод о спросе был бы ложным — «мало данных», в опыт магазина не идёт.
          const result = excludedExperiment(priceChangePercent, excluded);
          const evaluation = { ...result, window: { from, day, to }, skus: [...changedSkus], controlSkus: [] } as unknown as Prisma.InputJsonValue;
          await this.prisma.priceChange.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { evaluation, evaluatedAt: now } });
          evaluated += rows.length;
          lines.push(`${VERDICT_LABELS[result.verdict]} — товар ${productId}, ${day}: ${rows.length} SKU, цена ${priceChangePercent > 0 ? '+' : ''}${priceChangePercent.toFixed(1)}%. ${result.note}`);
          continue;
        }
        // Заказы — из учёта магазина: пока синхронизация не дошла до дня после окна, «после» неполное — ждём.
        if (!(await this.ordersSyncedAfter(to))) {
          this.logger.warn(`Ценовые эксперименты: заказы после ${to} ещё не синхронизированы — товар ${productId} отложен`);
          continue;
        }
        let funnel: WindowTotals;
        try {
          funnel = ordersByWindow(await this.orderItems(from, to, productId), { key: 'sku', from, to, split: day, skipSplitDay: true, days: WINDOW_DAYS });
        } catch (error: any) {
          this.logger.warn(`Ценовые эксперименты: заказы ${productId} не получены — ${error?.message || error}`);
          continue;
        }
        // Контроль — SKU того же товара, у которых цена в окне эксперимента не менялась.
        const touched = await this.prisma.priceChange.findMany({
          where: { productExternalId: productId, status: 'SENT', dryRun: false, createdAt: { gte: new Date(`${from}T00:00:00+05:00`), lte: new Date(`${to}T23:59:59+05:00`) } },
          select: { skuExternalId: true },
        });
        const touchedSkus = new Set(touched.map((row) => row.skuExternalId));
        const total = (skus: (sku: string) => boolean, window: 'before' | 'after') => {
          const result = empty();
          for (const [sku, byWindow] of funnel) {
            if (!skus(sku)) continue;
            const part = byWindow.get(window);
            if (!part) continue;
            result.impressions += part.impressions; result.views += part.views; result.carts += part.carts; result.orders += part.orders;
          }
          return result;
        };
        const isChanged = (sku: string) => changedSkus.has(sku);
        const isControl = (sku: string) => !touchedSkus.has(sku);
        const hasControl = [...funnel.keys()].some(isControl);
        const result = evaluateExperiment({
          changed: { before: total(isChanged, 'before'), after: total(isChanged, 'after') },
          control: hasControl ? { before: total(isControl, 'before'), after: total(isControl, 'after') } : null,
          priceChangePercent,
          uncontrolledSkus: [...funnel.keys()].filter((sku) => !isChanged(sku) && !isControl(sku)).length,
        });
        const evaluation = { ...result, window: { from, day, to }, skus: [...changedSkus], controlSkus: [...funnel.keys()].filter(isControl) } as unknown as Prisma.InputJsonValue;
        await this.prisma.priceChange.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { evaluation, evaluatedAt: now } });
        evaluated += rows.length;
        lines.push(`${VERDICT_LABELS[result.verdict]} — товар ${productId}, ${day}: ${rows.length} SKU, цена ${result.priceChangePercent > 0 ? '+' : ''}${result.priceChangePercent.toFixed(1)}%. ${result.note}`);
      }

      lines.push(...await this.evaluateMarketing(today, now));

      const messages: string[] = [];
      if (lines.length) {
        messages.push(...experimentReport(lines, await this.learnings()));
        if (options.notify) {
          for (const text of messages) {
            if (!(await this.integrations.notifyTelegram(text, 'notifyAgents').catch(() => false))) break;
          }
        }
      }
      this.logger.log(`Ценовые эксперименты: оценено изменений ${evaluated}, экспериментов ${lines.length}`);
      return { evaluated, messages };
    } finally {
      this.running = false;
    }
  }

  /** Сводка вердиктов за 90 дней — для ИИ-ревью автоцен и отчётов. */
  async learnings(): Promise<string | null> {
    const rows = await this.prisma.priceChange.findMany({
      where: { evaluatedAt: { gte: new Date(Date.now() - 90 * DAY_MS) } },
      select: { evaluation: true, productExternalId: true, createdAt: true },
    });
    // Одна строка эксперимента записана на каждый его SKU — считаем эксперименты, а не строки.
    const seen = new Map<string, { priceChangePercent: number; verdict: ExperimentVerdict }>();
    for (const row of rows) {
      const result = row.evaluation as unknown as (ExperimentResult & { window?: { day: string } }) | null;
      if (!result?.verdict) continue;
      seen.set(`${row.productExternalId}|${result.window?.day ?? tashkentDay(row.createdAt)}|${Math.sign(result.priceChangePercent)}`, { priceChangePercent: result.priceChangePercent, verdict: result.verdict });
    }
    return summarizeExperiments([...seen.values()]);
  }

  /** Синхронизация заказов дошла до дня после окна — значит, заказы окна в учёте полные. */
  private async ordersSyncedAfter(day: string): Promise<boolean> {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return false;
    const next = await this.prisma.order.findFirst({ where: { shopId: shop.id, orderedAt: { gte: new Date(`${shiftDay(day, 1)}T00:00:00+05:00`) } }, select: { id: true } });
    return Boolean(next);
  }

  /**
   * Позиции заказов активного магазина, заказанных с from по to (дни Ташкента), — для окон «до/после».
   * С productId — только этого товара (по SKU из учёта или id товара Uzum в позиции).
   */
  private async orderItems(from: string, to: string, productId?: string): Promise<ExperimentOrderItem[]> {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new Error('активный магазин не найден');
    const rows = await this.prisma.orderItem.findMany({
      where: {
        order: { shopId: shop.id, orderedAt: { gte: new Date(`${from}T00:00:00+05:00`), lt: new Date(`${shiftDay(to, 1)}T00:00:00+05:00`) } },
        ...(productId ? { OR: [{ marketplaceProductId: productId }, { sku: { product: { externalId: productId } } }] } : {}),
      },
      select: { quantity: true, marketplaceProductId: true, order: { select: { orderedAt: true } }, sku: { select: { externalId: true, product: { select: { externalId: true } } } } },
    });
    return rows
      .filter((row: any) => row.order?.orderedAt)
      .map((row: any) => ({
        orderedAt: row.order.orderedAt as Date,
        skuId: row.sku?.externalId ?? null,
        productId: row.sku?.product?.externalId || row.marketplaceProductId || null,
        quantity: Number(row.quantity) || 0,
      }));
  }

  // ---------- внешние кампании ----------

  private static readonly CHANNELS = ['INSTAGRAM', 'TELEGRAM', 'BLOGGER', 'OTHER'];

  async listMarketing() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return [];
    return this.prisma.marketingExperiment.findMany({ where: { shopId: shop.id }, orderBy: { startDate: 'desc' }, take: 100 });
  }

  async addMarketing(body: { channel?: string; productExternalId?: string; startDate?: string; budget?: number | string | null; note?: string | null }) {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Активный магазин не найден');
    const channel = String(body?.channel || '').toUpperCase();
    if (!PriceExperimentService.CHANNELS.includes(channel)) throw new BadRequestException('Канал: INSTAGRAM, TELEGRAM, BLOGGER или OTHER');
    const productExternalId = String(body?.productExternalId || '').trim();
    const product = await this.prisma.product.findFirst({ where: { shopId: shop.id, externalId: productExternalId } });
    if (!product) throw new BadRequestException('Товар не найден в магазине');
    const startDate = String(body?.startDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new BadRequestException('Дата старта в формате ГГГГ-ММ-ДД');
    const budgetRaw = body?.budget === null || body?.budget === undefined || body?.budget === '' ? null : Number(body.budget);
    if (budgetRaw !== null && (!Number.isFinite(budgetRaw) || budgetRaw < 0)) throw new BadRequestException('Бюджет — число в сумах');
    return this.prisma.marketingExperiment.create({
      data: { shopId: shop.id, channel, productExternalId, startDate, budget: budgetRaw === null ? null : Math.round(budgetRaw), note: body?.note ? String(body.note).slice(0, 500) : null },
    });
  }

  async removeMarketing(id: string) {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return { ok: false };
    await this.prisma.marketingExperiment.deleteMany({ where: { id, shopId: shop.id } });
    return { ok: true };
  }

  /** Кампании, которым исполнилось 7 полных дней: товар против остального магазина. */
  private async evaluateMarketing(today: string, now: Date): Promise<string[]> {
    const pending = await this.prisma.marketingExperiment.findMany({ where: { evaluatedAt: null } });
    const lines: string[] = [];
    const excludedDays = parseExcludedDays(process.env.PRICE_EXPERIMENT_EXCLUDE_DAYS);
    for (const row of pending) {
      const lastAfterDay = shiftDay(row.startDate, WINDOW_DAYS - 1);
      if (lastAfterDay >= today) continue;
      const from = shiftDay(row.startDate, -WINDOW_DAYS);
      const excluded = overlappingRange(from, lastAfterDay, excludedDays);
      if (excluded) {
        const result = excludedMarketing(excluded);
        await this.prisma.marketingExperiment.update({ where: { id: row.id }, data: { evaluation: result as unknown as Prisma.InputJsonValue, evaluatedAt: now } });
        lines.push(`❔ мало данных — ${row.channel} с ${row.startDate}, товар ${row.productExternalId}. ${result.note}`);
        continue;
      }
      if (!(await this.ordersSyncedAfter(lastAfterDay))) {
        this.logger.warn(`Внешняя кампания ${row.id}: заказы после ${lastAfterDay} ещё не синхронизированы — отложена`);
        continue;
      }
      let funnel: WindowTotals;
      try {
        funnel = ordersByWindow(await this.orderItems(from, lastAfterDay), { key: 'product', from, to: lastAfterDay, split: row.startDate, skipSplitDay: false, days: WINDOW_DAYS });
      } catch (error: any) {
        this.logger.warn(`Внешняя кампания ${row.id}: заказы не получены — ${error?.message || error}`);
        continue;
      }
      const pick = (filter: (id: string) => boolean, window: 'before' | 'after') => {
        const result = empty();
        for (const [id, byWindow] of funnel) {
          if (!filter(id)) continue;
          const part = byWindow.get(window);
          if (part) { result.impressions += part.impressions; result.views += part.views; result.carts += part.carts; result.orders += part.orders; }
        }
        return result;
      };
      const promoted = (id: string) => id === row.productExternalId;
      const others = (id: string) => id !== row.productExternalId;
      const result = evaluateMarketing({
        promoted: { before: pick(promoted, 'before'), after: pick(promoted, 'after') },
        control: [...funnel.keys()].some(others) ? { before: pick(others, 'before'), after: pick(others, 'after') } : null,
        budget: row.budget,
      });
      await this.prisma.marketingExperiment.update({ where: { id: row.id }, data: { evaluation: result as unknown as Prisma.InputJsonValue, evaluatedAt: now } });
      const label = result.verdict === 'HELPED' ? '✅ помогло' : result.verdict === 'NO_EFFECT' ? '➖ без эффекта' : '❔ мало данных';
      lines.push(`${label} — ${row.channel} с ${row.startDate}, товар ${row.productExternalId}${row.budget ? `, бюджет ${row.budget.toLocaleString('ru-RU')} сум` : ''}. ${result.note}`);
    }
    return lines;
  }
}
