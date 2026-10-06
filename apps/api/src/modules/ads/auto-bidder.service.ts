import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AdBotKeyword, AdBotOutcome, AdBotStats, drrPercent } from '../../common/ad-bot';
import {
  AUTO_BIDDER_DEFAULTS,
  AutoBidPolicy,
  AutoBidderConfig,
  AutoBidderPlan,
  BidLadderStep,
  bidForReach,
  formatAutoBidderReport,
  parseLadder,
  planAutoBidder,
  reachForBid,
} from '../../common/auto-bidder';
import { shiftDay, tashkentDay } from '../../common/auto-pricing';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PromoPricingService } from '../pricing/promo-pricing.service';
import { AdBotService, CampaignInfo } from './ad-bot.service';

const CACHE_MS = 60_000;
const EMPTY: AdBotStats = { impressions: 0, clicks: 0, sold: 0, revenue: 0, spend: 0, position: null };

export type PolicyInput = { campaignId: string; skuGroupId: string; query: string; targetReach: number; maxBid: number; maxDrr: number | null; enabled?: boolean };
export type AutoBidderRunResult = { apply: boolean; today: string; plan: AutoBidderPlan; outcomes: AdBotOutcome[]; notes: string[]; messages: string[] };

/**
 * Автобиддер «Буст в ТОП»: для слов с включённой авто-ставкой (AdKeywordPolicy) раз в час (AUTO_BIDDER_CRON)
 * читает ставки и статистику из кабинета, при настроенном AD_BID_LADDER_URL — «лестницу» цен охвата, решает по
 * правилам common/auto-bidder.ts и присылает отчёт в Telegram, только если что-то поменялось. По умолчанию — предложения;
 * AUTO_BIDDER_APPLY=true — меняет ставки тем же PUT кампании, что и рекламный бот. Журнал — AdBotChange (reason с «авто-ставка»).
 *
 * AD_BID_LADDER_URL — шаблон GET-запроса кабинета с подстановками {campaignId}, {adId}, {skuGroupId}, {query}; ответ —
 * массив ступеней { position, cpm, impressionPercent } в любой из принимаемых parseLadder форм. Пока не задан — лестницы нет,
 * и автобид только держит ставку в пределах потолка и ДРР.
 */
@Injectable()
export class AutoBidderService {
  private readonly logger = new Logger(AutoBidderService.name);
  private running = false;
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly cabinet: PromoPricingService,
    private readonly adBot: AdBotService,
  ) {}

  @Cron(process.env.AUTO_BIDDER_CRON || '20 * * * *', { name: 'auto-bidder', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    if (process.env.AUTO_BIDDER_ENABLED === 'false') return;
    const count = await this.prisma.adKeywordPolicy.count({ where: { enabled: true, pausedAt: null } }).catch(() => 0);
    if (!count) return;
    this.logger.log(`Авто-ставка: запуск по расписанию, слов ${count}`);
    try {
      await this.run({ apply: this.applyEnabled(), notify: true });
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`Авто-ставка: ${message}`);
      await this.integrations.notifyTelegram(`⚠️ Авто-ставка: запуск не выполнен — ${message}`, 'notifyAgents').catch(() => undefined);
    }
  }

  applyEnabled() { return process.env.AUTO_BIDDER_APPLY === 'true'; }
  ladderConfigured() { return Boolean(process.env.AD_BID_LADDER_URL); }

  config(): AutoBidderConfig {
    const env = (name: string) => {
      const value = Number(process.env[name]);
      return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) && value > 0 ? value : null;
    };
    return {
      ...AUTO_BIDDER_DEFAULTS,
      cooldownMinutes: env('AUTO_BIDDER_COOLDOWN_MINUTES') ?? AUTO_BIDDER_DEFAULTS.cooldownMinutes,
      maxStepPercent: env('AUTO_BIDDER_MAX_STEP_PERCENT') ?? AUTO_BIDDER_DEFAULTS.maxStepPercent,
    };
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Кампании «Буст в ТОП» для экрана: статус, бюджет, период и число слов на авто-ставке. */
  async campaigns() {
    const today = tashkentDay(new Date());
    const sellerId = await this.cached('sellerId', () => this.adBot.sellerId(today));
    const rows = await this.cached(`campaigns:${today}`, () => this.adBot.listCampaigns(sellerId, today));
    const policies = await this.prisma.adKeywordPolicy.groupBy({ by: ['campaignId'], where: { enabled: true }, _count: { _all: true } }).catch(() => [] as any[]);
    const paused = await this.prisma.adKeywordPolicy.groupBy({ by: ['campaignId'], where: { enabled: true, pausedAt: { not: null } }, _count: { _all: true } }).catch(() => [] as any[]);
    const count = (list: any[], id: string) => Number(list.find((row) => row.campaignId === id)?._count?._all ?? 0);
    const order = (status: string) => (status === 'ACTIVE' ? 0 : 1);
    return {
      apply: this.applyEnabled(),
      ladder: this.ladderConfigured(),
      campaigns: rows
        .map((row) => ({
          id: row.id, name: row.name, status: row.status ?? '', skuGroups: (row.skuGroupIds ?? []).length,
          weeklyBudget: Number(row.budgetConfig?.weeklyAmount) || null,
          uniformDistribution: Boolean(row.budgetConfig?.uniformDistribution),
          remainingBudget: this.remainingBudget(row),
          period: row.period ? { from: row.period.dateFrom ?? null, to: row.period.dateTo ?? null, endless: Boolean(row.period.isEndless) } : null,
          managed: count(policies, row.id), paused: count(paused, row.id),
        }))
        .sort((a, b) => order(a.status) - order(b.status) || String(b.period?.from ?? '').localeCompare(String(a.period?.from ?? ''))),
    };
  }

  private remainingBudget(row: CampaignInfo): number | null {
    const raw = row.raw ?? {};
    for (const key of ['remainingBudget', 'budgetRemaining', 'dailyRemaining', 'remainingDailyBudget', 'todayRemaining']) {
      if (Number.isFinite(Number(raw[key]))) return Number(raw[key]);
    }
    for (const key of ['remaining', 'remainingAmount', 'dailyRemaining', 'todayRemaining']) {
      if (Number.isFinite(Number(raw.budgetConfig?.[key]))) return Number(raw.budgetConfig[key]);
    }
    return null;
  }

  /** Слова кампании со статистикой за 7 дней, политикой и (если настроено) лестницей охвата. */
  async keywords(campaignId: string) {
    const today = tashkentDay(new Date());
    const yesterday = shiftDay(today, -1);
    const sellerId = await this.cached('sellerId', () => this.adBot.sellerId(today));
    const campaigns = await this.cached(`campaigns:${today}`, () => this.adBot.listCampaigns(sellerId, today));
    const campaign = campaigns.find((row) => row.id === String(campaignId));
    if (!campaign) throw new NotFoundException(`кампания ${campaignId} не найдена в кабинете`);
    const keywords = await this.cached(`keywords:${campaignId}`, () => this.adBot.loadKeywords(campaign));
    const stats7 = await this.cached(`stats7:${today}`, () => this.adBot.keywordStats(sellerId, shiftDay(yesterday, -6), yesterday));
    const policies = await this.prisma.adKeywordPolicy.findMany({ where: { campaignId: String(campaignId) } });
    const policyById = new Map(policies.map((row: any) => [row.adId, row]));
    const changes = await this.prisma.adBotChange.findMany({
      where: { campaignId: String(campaignId), status: 'SENT', dryRun: false, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    const lastChange = new Map<string, any>();
    for (const row of changes as any[]) if (row.adId && !lastChange.has(row.adId)) lastChange.set(row.adId, row);
    const cfg = this.config();
    const rows: any[] = [];
    for (const keyword of keywords) {
      const stats = stats7.get(keyword.adId) ?? EMPTY;
      const ladder = this.ladderConfigured() ? await this.ladder(keyword).catch(() => null) : null;
      const policy: any = policyById.get(keyword.adId) ?? null;
      const target = ladder && policy ? bidForReach(ladder, policy.targetReach) : null;
      const drr = drrPercent(stats);
      const last = lastChange.get(keyword.adId);
      rows.push({
        adId: keyword.adId, skuGroupId: keyword.skuGroupId, query: keyword.query, cpm: keyword.cpm, stopWords: keyword.stopWords.length,
        minBid: cfg.minBid,
        stats: { ...stats, ctr: stats.impressions > 0 ? (stats.clicks / stats.impressions) * 100 : null, drr, roas: stats.spend > 0 ? stats.revenue / stats.spend : null },
        ladder: ladder ?? null,
        reach: ladder ? reachForBid(ladder, keyword.cpm) : null,
        targetCpm: target?.cpm ?? null,
        policy: policy ? this.policyView(policy) : null,
        lastChange: last ? { at: last.createdAt, oldCpm: last.oldCpm, newCpm: last.newCpm, reason: last.reason } : null,
      });
    }
    return {
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status ?? '', weeklyBudget: Number(campaign.budgetConfig?.weeklyAmount) || null, remainingBudget: this.remainingBudget(campaign) },
      apply: this.applyEnabled(), ladder: this.ladderConfigured(), minBid: cfg.minBid, reachOptions: cfg.reachOptions,
      period: { from: shiftDay(yesterday, -6), to: yesterday },
      keywords: rows,
    };
  }

  private policyView(row: any) {
    return {
      enabled: row.enabled, targetReach: row.targetReach, maxBid: row.maxBid, maxDrr: row.maxDrr ?? null,
      pausedAt: row.pausedAt ?? null, pausedNote: row.pausedNote ?? null, lastRunAt: row.lastRunAt ?? null, lastBid: row.lastBid ?? null, lastNote: row.lastNote ?? null, updatedAt: row.updatedAt,
    };
  }

  /** Лестница охвата из кабинета по шаблону AD_BID_LADDER_URL; не настроен — null. Кэш 1 минута. */
  async ladder(keyword: Pick<AdBotKeyword, 'campaignId' | 'adId' | 'skuGroupId' | 'query'>): Promise<BidLadderStep[] | null> {
    const template = process.env.AD_BID_LADDER_URL;
    if (!template) return null;
    const url = template
      .replace('{campaignId}', encodeURIComponent(keyword.campaignId))
      .replace('{adId}', encodeURIComponent(keyword.adId))
      .replace('{skuGroupId}', encodeURIComponent(keyword.skuGroupId))
      .replace('{query}', encodeURIComponent(keyword.query));
    return this.cached(`ladder:${url}`, async () => parseLadder((await this.cabinet.cabinet('GET', url)).body));
  }

  async upsertPolicy(adId: string, input: PolicyInput) {
    const cfg = this.config();
    if (!cfg.reachOptions.includes(input.targetReach)) throw new BadRequestException(`охват должен быть одним из: ${cfg.reachOptions.join(', ')}%`);
    if (input.maxBid < cfg.minBid) throw new BadRequestException(`максимальная ставка ниже минимальной ставки Uzum по запросу (${cfg.minBid.toLocaleString('ru-RU')} сум) — с ней реклама показываться не будет`);
    if (input.maxDrr !== null && (input.maxDrr <= 0 || input.maxDrr > 100)) throw new BadRequestException('максимальный ДРР — число от 0 до 100 %');
    const data = {
      campaignId: String(input.campaignId), skuGroupId: String(input.skuGroupId), query: input.query,
      targetReach: input.targetReach, maxBid: Math.round(input.maxBid), maxDrr: input.maxDrr,
      enabled: input.enabled ?? true, pausedAt: null, pausedNote: null,
    };
    const row = await this.prisma.adKeywordPolicy.upsert({ where: { adId: String(adId) }, update: data, create: { adId: String(adId), ...data } });
    this.cache.delete(`keywords:${input.campaignId}`);
    return this.policyView(row);
  }

  async disablePolicy(adId: string) {
    const row = await this.prisma.adKeywordPolicy.findUnique({ where: { adId: String(adId) } });
    if (!row) throw new NotFoundException('авто-ставка для этого слова не настроена');
    const updated = await this.prisma.adKeywordPolicy.update({ where: { adId: String(adId) }, data: { enabled: false, pausedAt: null, pausedNote: null } });
    return this.policyView(updated);
  }

  async changes(limit = 100) {
    return this.prisma.adBotChange.findMany({ where: { reason: { startsWith: 'авто-ставка' } }, orderBy: { createdAt: 'desc' }, take: Math.min(500, Math.max(1, limit)) });
  }

  async run(options: { apply: boolean; notify: boolean }): Promise<AutoBidderRunResult> {
    if (this.running) throw new Error('авто-ставка уже выполняется');
    this.running = true;
    try {
      const now = new Date();
      const today = tashkentDay(now);
      const yesterday = shiftDay(today, -1);
      const cfg = this.config();
      const notes: string[] = [];
      const apply = options.apply && this.applyEnabled();
      if (options.apply && !apply) notes.push('AUTO_BIDDER_APPLY не включён — ставки не меняются, только предложения');
      if (!this.ladderConfigured()) notes.push('AD_BID_LADDER_URL не задан — лестницы охвата нет, автобид держит ставки в пределах потолка и ДРР');

      const policyRows = await this.prisma.adKeywordPolicy.findMany({ where: { enabled: true } });
      const policies: AutoBidPolicy[] = (policyRows as any[]).map((row) => ({
        adId: row.adId, campaignId: row.campaignId, skuGroupId: row.skuGroupId, query: row.query, enabled: row.enabled,
        targetReach: row.targetReach, maxBid: row.maxBid, maxDrr: row.maxDrr ?? null, pausedAt: row.pausedAt ?? null,
      }));
      const empty: AutoBidderPlan = { rows: [], actions: [], notes: [] };
      if (!policies.length) return { apply, today, plan: empty, outcomes: [], notes: ['нет слов с включённой авто-ставкой'], messages: [] };

      const sellerId = await this.adBot.sellerId(today);
      const campaignIds = new Set(policies.map((row) => row.campaignId));
      const campaigns = new Map<string, CampaignInfo>();
      const keywords = new Map<string, AdBotKeyword>();
      for (const info of await this.adBot.listCampaigns(sellerId, today)) {
        if (!campaignIds.has(info.id)) continue;
        campaigns.set(info.id, info);
        if (info.status !== 'ACTIVE') { notes.push(`кампания «${info.name}» не активна — её слова пропущены`); continue; }
        for (const keyword of await this.adBot.loadKeywords(info)) keywords.set(keyword.adId, keyword);
      }
      const stats7 = await this.adBot.keywordStats(sellerId, shiftDay(yesterday, -6), yesterday);
      const stats14 = await this.adBot.keywordStats(sellerId, shiftDay(yesterday, -13), yesterday);
      const history = await this.prisma.adBotChange.findMany({
        where: { adId: { in: policies.map((row) => row.adId) }, status: 'SENT', dryRun: false, createdAt: { gte: new Date(now.getTime() - 2 * 86_400_000) } },
        orderBy: { createdAt: 'desc' },
      });
      const lastChange = new Map<string, Date>();
      for (const row of history as any[]) if (row.adId && !lastChange.has(row.adId)) lastChange.set(row.adId, row.createdAt);
      const ladders = new Map<string, BidLadderStep[] | null>();
      for (const policy of policies) {
        const keyword = keywords.get(policy.adId);
        if (!keyword) continue;
        ladders.set(policy.adId, await this.ladder(keyword).catch((error: any) => { notes.push(`«${keyword.query}»: лестница не получена — ${String(error?.message || error).slice(0, 120)}`); return null; }));
      }

      const plan = planAutoBidder(policies, keywords, (adId) => ({
        ladder: ladders.get(adId) ?? null, stats7: stats7.get(adId) ?? EMPTY, stats14: stats14.get(adId) ?? EMPTY, lastChange: lastChange.get(adId) ?? null, now,
      }), cfg);

      const outcomes = apply ? await this.adBot.apply(plan.actions, campaigns, { stats14, stats7 }) : [];
      if (!apply && plan.actions.length) await this.adBot.journal(plan.actions, { stats14, stats7 }, { dryRun: true, status: 'PLANNED' });

      // Состояние политик: последняя проверка, ставка, заметка; пауза — только когда изменение реально отправлено.
      const okByAd = new Map(outcomes.map((row) => [row.action.adId, row.ok]));
      for (const row of plan.rows) {
        const paused = row.decision.kind === 'PAUSE' && (apply ? okByAd.get(row.keyword.adId) === true : false);
        await this.prisma.adKeywordPolicy.update({
          where: { adId: row.policy.adId },
          data: {
            lastRunAt: now, lastBid: apply && okByAd.get(row.keyword.adId) ? row.decision.newCpm : row.keyword.cpm,
            lastNote: `${row.decision.kind}: ${row.decision.reason}`.slice(0, 500),
            ...(paused ? { pausedAt: now, pausedNote: row.decision.reason.slice(0, 500) } : {}),
          },
        }).catch(() => undefined);
      }

      const label = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now);
      const messages = formatAutoBidderReport({ label, apply, plan, outcomes, notes });
      const changed = plan.rows.some((row) => row.decision.kind !== 'KEEP') || outcomes.some((row) => !row.ok);
      if (options.notify && changed) {
        for (const text of messages) {
          if (!(await this.integrations.notifyTelegram(text, 'notifyAgents'))) { this.logger.warn('Авто-ставка: отчёт не отправлен — Telegram не настроен или выключено «Автоцены и реклама»'); break; }
        }
      }
      this.logger.log(`Авто-ставка (${apply ? 'изменения' : 'предложения'}): слов ${plan.rows.length}, изменений ${plan.actions.length}, ошибок ${outcomes.filter((row) => !row.ok).length}`);
      this.cache.clear();
      return { apply, today, plan, outcomes, notes, messages };
    } finally {
      this.running = false;
    }
  }
}
