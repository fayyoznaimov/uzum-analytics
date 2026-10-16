import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AdBotAction, AdBotStats } from '../../common/ad-bot';
import { AD_LADDER_DEFAULTS, AdLadderConfig, formatLadderReport, LadderDecision, LadderKeyword, ladderCampaigns, ladderEnabled, planLadderBids } from '../../common/ad-ladder';
import { tashkentDay } from '../../common/auto-pricing';
import { IntegrationsService } from '../integrations/integrations.service';
import { AdBotService } from './ad-bot.service';
import { AutoBidderService } from './auto-bidder.service';


/**
 * «Лестница ставок»: раз в день (AD_LADDER_CRON, по умолчанию 10:30 Ташкент) снимает лестницу охвата кабинета по каждому
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
    private readonly integrations: IntegrationsService,
    private readonly adBot: AdBotService,
    private readonly autoBidder: AutoBidderService,
  ) {}

  applyEnabled() { return process.env.AD_LADDER_APPLY !== 'false'; }

  config(): AdLadderConfig {
    const max = Number(process.env.AD_BOT_MAX_BID);
    return { ...AD_LADDER_DEFAULTS, maxBid: Number.isFinite(max) && max > 0 ? max : AD_LADDER_DEFAULTS.maxBid };
  }

  @Cron(process.env.AD_LADDER_CRON || '30 10 * * *', { name: 'ad-ladder', timeZone: 'Asia/Tashkent' })
  async scheduled() {
    if (!ladderEnabled()) return;
    this.logger.log('Лестница ставок: запуск по расписанию');
    try {
      await this.run({ apply: this.applyEnabled(), notify: true });
    } catch (error: any) {
      const message = String(error?.message || error);
      this.logger.error(`Лестница ставок: ${message}`);
      await this.integrations.notifyTelegram(`⚠️ Лестница ставок: запуск не выполнен — ${message}`, 'notifyAgents').catch(() => undefined);
    }
  }

  async run(options: { apply: boolean; notify: boolean; campaignIds?: string[] }): Promise<{ decisions: LadderDecision[]; failed: number; report: string; notes: string[] }> {
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
      const decisions = planLadderBids(keywords, this.config());
      const actions = decisions.map((row) => row.action).filter((row): row is AdBotAction => Boolean(row));
      let failed = 0;
      if (options.apply && actions.length) {
        const empty = { stats14: new Map<string, AdBotStats>(), stats7: new Map<string, AdBotStats>() };
        const outcomes = await this.adBot.apply(actions, new Map(campaigns.map((row) => [row.id, row])), empty);
        failed = outcomes.filter((row) => !row.ok).length;
      }
      const report = formatLadderReport(decisions, { apply: options.apply, failed, notes: notes.slice(0, 10) });
      if (options.notify && (actions.length || notes.length)) {
        await this.integrations.notifyTelegram(report, 'notifyAgents').catch((error: any) => this.logger.warn(`Лестница ставок: Telegram — ${error?.message || error}`));
      }
      this.logger.log(`Лестница ставок: правок ${actions.length}, не прошло ${failed}`);
      return { decisions, failed, report, notes };
    } finally {
      this.running = false;
    }
  }
}
