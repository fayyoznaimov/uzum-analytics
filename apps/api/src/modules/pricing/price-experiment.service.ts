import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { cubeUrl, isCubeContinueWait } from '../../common/ad-agent';
import {
  evaluateExperiment,
  evaluateMarketing,
  ExperimentResult,
  ExperimentVerdict,
  FunnelTotals,
  summarizeExperiments,
  VERDICT_LABELS,
} from '../../common/price-experiment';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PromoPricingService } from './promo-pricing.service';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const F = 'SellerReportProductFunnelSku.';

const tashkentDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(date);
const shiftDay = (day: string, days: number) => tashkentDay(new Date(new Date(`${day}T12:00:00+05:00`).getTime() + days * DAY_MS));
const empty = (): FunnelTotals => ({ impressions: 0, views: 0, carts: 0, orders: 0, days: WINDOW_DAYS });

/**
 * Через 7 дней после каждого реального изменения цены сравнивает воронку
 * Uzum «до/после» с контролем (SKU того же товара без изменений цены) и
 * записывает вердикт в PriceChange.evaluation. Опыт магазина затем видит
 * ИИ-ревью автоцен и владелец в Telegram.
 */
@Injectable()
export class PriceExperimentService {
  private readonly logger = new Logger(PriceExperimentService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly cabinet: PromoPricingService,
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
      for (const [key, rows] of groups) {
        const [productId, day] = key.split('|');
        const from = shiftDay(day, -WINDOW_DAYS);
        const to = shiftDay(day, WINDOW_DAYS);
        if (to >= today) continue;
        let funnel: Map<string, Map<string, FunnelTotals>>;
        try {
          funnel = await this.funnelBySku(productId, from, to);
        } catch (error: any) {
          this.logger.warn(`Ценовые эксперименты: воронка ${productId} не получена — ${error?.message || error}`);
          continue;
        }
        const changedSkus = new Set(rows.map((row) => row.skuExternalId));
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
        const priceChangePercent = rows.reduce((sumPct, row) => sumPct + (row.newPrice - (row.oldPrice as number)) / (row.oldPrice as number) * 100, 0) / rows.length;
        const result = evaluateExperiment({
          changed: { before: total(isChanged, 'before'), after: total(isChanged, 'after') },
          control: hasControl ? { before: total(isControl, 'before'), after: total(isControl, 'after') } : null,
          priceChangePercent,
        });
        const evaluation = { ...result, window: { from, day, to }, skus: [...changedSkus], controlSkus: [...funnel.keys()].filter(isControl) } as unknown as Prisma.InputJsonValue;
        await this.prisma.priceChange.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { evaluation, evaluatedAt: now } });
        evaluated += rows.length;
        lines.push(`${VERDICT_LABELS[result.verdict]} — товар ${productId}, ${day}: ${rows.length} SKU, цена ${result.priceChangePercent > 0 ? '+' : ''}${result.priceChangePercent.toFixed(1)}%. ${result.note}`);
      }

      lines.push(...await this.evaluateMarketing(today, now));

      const messages: string[] = [];
      if (lines.length) {
        const learned = await this.learnings();
        messages.push(['📊 Ценовые эксперименты: итоги через 7 дней', '', ...lines, ...(learned ? ['', `Опыт магазина за 90 дней: ${learned}`] : [])].join('\n'));
        if (options.notify) await this.integrations.notifyTelegram(messages[0], 'notifyAgents').catch(() => false);
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

  /** Воронка товара по SKU: суммы за 7 дней до дня изменения и за 7 дней после. */
  private async funnelBySku(productId: string, from: string, to: string): Promise<Map<string, Map<string, FunnelTotals>>> {
    const query = {
      measures: ['sum_imps', 'sum_views', 'sum_atc', 'generated_amount'].map((m) => F + m),
      dimensions: [F + 'product_id', F + 'sku_id'],
      timezone: 'Asia/Tashkent',
      timeDimensions: [{ dimension: F + 'date', dateRange: [from, to], granularity: 'day' }],
      filters: [{ member: F + 'product_id', operator: 'equals', values: [productId] }],
      limit: 10_000,
    };
    let body: any = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      body = (await this.cabinet.cabinet('GET', cubeUrl(query as any))).body;
      if (!isCubeContinueWait(body)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const rows: any[] = body?.data ?? body?.results?.[0]?.data ?? [];
    const day = to.slice(0, 10);
    const changeDay = shiftDay(from, WINDOW_DAYS);
    const num = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
    const result = new Map<string, Map<string, FunnelTotals>>();
    for (const row of rows) {
      const date = String(row[F + 'date.day'] ?? row[F + 'date'] ?? '').slice(0, 10);
      // День изменения в окна не входит: цена в нём была и старой, и новой.
      if (!date || date === changeDay || date > day) continue;
      const window = date < changeDay ? 'before' : 'after';
      const sku = String(row[F + 'sku_id'] ?? '');
      if (!sku) continue;
      const bySku = result.get(sku) ?? new Map<string, FunnelTotals>();
      const totals = bySku.get(window) ?? empty();
      totals.impressions += num(row[F + 'sum_imps']);
      totals.views += num(row[F + 'sum_views']);
      totals.carts += num(row[F + 'sum_atc']);
      totals.orders += num(row[F + 'generated_amount']);
      bySku.set(window, totals);
      result.set(sku, bySku);
    }
    return result;
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
    for (const row of pending) {
      const lastAfterDay = shiftDay(row.startDate, WINDOW_DAYS - 1);
      if (lastAfterDay >= today) continue;
      let funnel: Map<string, Map<string, FunnelTotals>>;
      try {
        funnel = await this.funnelByProduct(shiftDay(row.startDate, -WINDOW_DAYS), lastAfterDay, row.startDate);
      } catch (error: any) {
        this.logger.warn(`Внешняя кампания ${row.id}: воронка не получена — ${error?.message || error}`);
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

  /** Воронка всех товаров: 7 дней до старта и 7 дней со дня старта. */
  private async funnelByProduct(from: string, to: string, startDate: string): Promise<Map<string, Map<string, FunnelTotals>>> {
    const query = {
      measures: ['sum_imps', 'sum_views', 'sum_atc', 'generated_amount'].map((m) => F + m),
      dimensions: [F + 'product_id'],
      timezone: 'Asia/Tashkent',
      timeDimensions: [{ dimension: F + 'date', dateRange: [from, to], granularity: 'day' }],
      limit: 10_000,
    };
    let body: any = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      body = (await this.cabinet.cabinet('GET', cubeUrl(query as any))).body;
      if (!isCubeContinueWait(body)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const rows: any[] = body?.data ?? body?.results?.[0]?.data ?? [];
    const num = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
    const result = new Map<string, Map<string, FunnelTotals>>();
    for (const row of rows) {
      const date = String(row[F + 'date.day'] ?? row[F + 'date'] ?? '').slice(0, 10);
      const id = String(row[F + 'product_id'] ?? '');
      if (!date || !id || date > to) continue;
      const window = date < startDate ? 'before' : 'after';
      const byWindow = result.get(id) ?? new Map<string, FunnelTotals>();
      const totals = byWindow.get(window) ?? empty();
      totals.impressions += num(row[F + 'sum_imps']); totals.views += num(row[F + 'sum_views']);
      totals.carts += num(row[F + 'sum_atc']); totals.orders += num(row[F + 'generated_amount']);
      byWindow.set(window, totals);
      result.set(id, byWindow);
    }
    return result;
  }
}
