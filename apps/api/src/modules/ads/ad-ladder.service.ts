import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AdBotAction, AdBotStats } from '../../common/ad-bot';
import { AD_LADDER_DEFAULTS, AdLadderConfig, formatLadderReport, LadderDecision, LadderKeyword, ladderCampaigns, ladderEnabled, ladderKey, planLadderBids } from '../../common/ad-ladder';
import { tashkentDay } from '../../common/auto-pricing';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { AdBotService } from './ad-bot.service';
import { AutoBidderService } from './auto-bidder.service';


/** Час по Ташкенту (0–23). */
const tashkentHour = (date: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hourCycle: 'h23' }).format(date));

/** Часы отчёта в Telegram (AD_LADDER_REPORT_HOURS, по умолчанию 10 и 19): сверка идёт каждый час, отчёт — только в эти часы. */
export function ladderReportHours(): number[] {
  const hours = String(process.env.AD_LADDER_REPORT_HOURS ?? '10,19').split(',').map((h) => Number(h.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h < 24);
  return hours.length ? hours.sort((a, b) => a - b) : [10, 19];
}

/**
 * «Лестница ставок»: каждый час (AD_LADDER_CRON, по умолчанию в :30 по Ташкенту; 17.10.2026 владелец: «можно чекать каждый
 * час?» — раньше раз в день в 10:30, но лестница за день гуляет вдвое) снимает лестницу охвата кабинета по каждому
 * слову кампаний ladderCampaigns() и ставит ставки по правилу common/ad-ladder.ts — на каждом запросе в топ-10 один-два
 * самых дешёвых цвета, остальные ниже топ-10, без переплаты. Владелец 16.10.2026: «сверяй лестницы раз в день и правь
 * ставки сам, итог присылай мне» — поэтому ставки меняются сразу; AD_LADDER_APPLY=false — только предложения,
 * AD_LADDER_ENABLED=false — выключено. Ставки этих кампаний рекламный бот больше не трогает (managed), минус-слова — да.
 * Правки идут тем же PUT кампании (AdBotService.apply), журнал — AdBotChange с причиной «лестница: …», отчёт — Telegram.
 */
@Injectable()
export class AdLadderService {
  private readonly logger = new Logger(AdLadderService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly adBot: AdBotService,
    private readonly autoBidder: AutoBidderService,
  ) {}

  applyEnabled() { return process.env.AD_LADDER_APPLY !== 'false'; }

  config(): AdLadderConfig {
    const max = Number(process.env.AD_BOT_MAX_BID);
    return { ...AD_LADDER_DEFAULTS, maxBid: Number.isFinite(max) && max > 0 ? max : AD_LADDER_DEFAULTS.maxBid };
  }

  @Cron(process.env.AD_LADDER_CRON || '30 * * * *', { name: 'ad-ladder', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    if (!ladderEnabled()) return;
    this.logger.log('Лестница ставок: запуск по расписанию');
    try {
      const hours = ladderReportHours();
      const hour = tashkentHour(new Date());
      await this.run({ apply: this.applyEnabled(), notify: hours.includes(hour), since: hours.includes(hour) ? this.previousReportHour(hours, hour) : undefined });
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`Лестница ставок: ${message}`);
      await this.integrations.notifyTelegram(`⚠️ Лестница ставок: запуск не выполнен — ${message}`, 'notifyAgents').catch(() => undefined);
    }
  }

  /** Сколько часов назад был предыдущий отчёт (для строки «правок с прошлого отчёта»). */
  private previousReportHour(hours: number[], hour: number): number {
    const before = hours.filter((h) => h < hour);
    const prev = before.length ? before[before.length - 1] : hours[hours.length - 1] - 24;
    return hour - prev;
  }

  /** Слова, которые лестница правила за последние hours часов (ключ «кампания|цвет|запрос»). */
  private async recentKeys(campaignIds: string[], hours: number): Promise<{ keys: Set<string>; count: number }> {
    const rows: Array<{ campaignId: string; skuGroupId: string; query: string }> = await this.prisma.adBotChange.findMany({
      where: { campaignId: { in: campaignIds }, status: 'SENT', dryRun: false, reason: { startsWith: 'лестница' }, createdAt: { gte: new Date(Date.now() - hours * 3_600_000) } },
      select: { campaignId: true, skuGroupId: true, query: true },
    }).catch(() => [] as Array<{ campaignId: string; skuGroupId: string; query: string }>);
    return { keys: new Set(rows.map((row) => ladderKey(row))), count: rows.length };
  }

  /** since — часов с прошлого отчёта: в отчёт добавляется число правок лестницы за это время. */
  async run(options: { apply: boolean; notify: boolean; campaignIds?: string[]; since?: number }): Promise<{ decisions: LadderDecision[]; failed: number; report: string; notes: string[] }> {
    if (this.running) throw new Error('лестница ставок уже выполняется');
    this.running = true;
    try {
      const today = tashkentDay(new Date());
      const ids = new Set(options.campaignIds ?? ladderCampaigns());
      const sellerId = await this.adBot.sellerId(today);
      const campaigns = (await this.adBot.listCampaigns(sellerId, today)).filter((row) => ids.has(row.id));
      const notes: string[] = [];
      for (const id of ids) if (!campaigns.some((row) => row.id === id)) notes.push(`кампания ${id} не активна — пропущена`);
      const keywords: LadderKeyword[] = [];
      for (const campaign of campaigns) {
        for (const keyword of await this.adBot.loadKeywords(campaign)) {
          const ladder = await this.autoBidder.ladder(keyword).catch((error: any) => {
            notes.push(`«${keyword.query}»: лестница не получена — ${String(error?.message || error).slice(0, 100)}`);
            return null;
          });
          keywords.push({ ...keyword, ladder });
        }
      }
      const cfg = this.config();
      const recent = await this.recentKeys([...ids], cfg.cooldownHours);
      const decisions = planLadderBids(keywords, cfg, recent.keys);
      const actions = decisions.map((row) => row.action).filter((row): row is AdBotAction => Boolean(row));
      let failed = 0;
      if (options.apply && actions.length) {
        const empty = { stats14: new Map<string, AdBotStats>(), stats7: new Map<string, AdBotStats>() };
        const outcomes = await this.adBot.apply(actions, new Map(campaigns.map((row) => [row.id, row])), empty);
        failed = outcomes.filter((row) => !row.ok).length;
      }
      if (options.since) notes.unshift(`с прошлого отчёта (${options.since} ч) правок лестницы: ${(await this.recentKeys([...ids], options.since)).count}`);
      const report = formatLadderReport(decisions, { apply: options.apply, failed, notes: notes.slice(0, 10) });
      if (options.notify || failed) {
        await this.integrations.notifyTelegram(report, 'notifyAgents').catch((error: any) => this.logger.warn(`Лестница ставок: Telegram — ${error?.message || error}`));
      }
      this.logger.log(`Лестница ставок: правок ${actions.length}, не прошло ${failed}`);
      return { decisions, failed, report, notes };
    } finally {
      this.running = false;
    }
  }
}
