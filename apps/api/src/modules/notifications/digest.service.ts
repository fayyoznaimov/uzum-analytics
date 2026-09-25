import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { IntegrationsService } from '../integrations/integrations.service';

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboard: DashboardService,
    private readonly integrations: IntegrationsService,
  ) {}

  private tashkentParts() {
    const now = new Date();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    return { date, time };
  }

  @Cron('* * * * *')
  async scheduledDigest() {
    try {
      const telegram = await this.integrations.getPlain(IntegrationType.TELEGRAM);
      if (!telegram?.token || telegram.metadata?.notifyDailyDigest === false) return;
      const { date, time } = this.tashkentParts();
      const configured = String(telegram.metadata?.dailyDigestTime || '09:00');
      if (time !== configured) return;
      const dedupeKey = `daily-digest:${date}`;
      if (await this.prisma.notificationLog.findUnique({ where: { dedupeKey } })) return;

      const data: any = await this.dashboard.overview({ from: date, to: date, compare: false });
      if (data?.empty) return;
      const m = data.metrics;
      const money = (value: number) => Math.round(value).toLocaleString('ru-RU');
      const configuredHoldDays = Number(data.payoutForecast?.holdDays);
      const holdDaysLabel = Number.isFinite(configuredHoldDays)
        ? `${Math.max(0, Math.trunc(configuredHoldDays))} дн.`
        : 'по настройке';
      const message = [
        `📊 ${data.shop?.name || 'Uzum Analytics'} — отчёт за ${date}`,
        `Заказано товаров: ${m.orderedUnits} шт.`,
        `Оплачено: ${m.paidUnits} шт. на ${money(m.revenue)} сум`,
        `Ждут оплаты: ${m.waitingUnits} шт. на ${money(m.waitingRevenue)} сум`,
        `К выплате: ${money(m.payout)} сум`,
        `Чистая прибыль: ${money(m.profit)} сум`,
        `Комиссия МП: ${money(m.commission)} сум (${Number(m.commissionPercent).toFixed(1)}%)`,
        `Логистика Uzum: ${money(m.marketplaceLogistics)} сум`,
        `Уже в корзине вывода: ${money(data.payoutForecast?.summary?.availableToWithdraw || 0)} сум`,
        `В удержании ${holdDaysLabel}: ${money(data.payoutForecast?.summary?.inReturnHold || 0)} сум`,
        `По графику сегодня: ${money(data.payoutForecast?.summary?.dueToday || 0)} сум`,
        `По графику за 7 дней: ${money(data.payoutForecast?.summary?.next7Days || 0)} сум`,
      ].join('\n');
      await this.integrations.notifyTelegram(message, 'notifyDailyDigest');
      await this.prisma.notificationLog.create({ data: { type: 'DAILY_DIGEST', dedupeKey, payload: { date } } });
    } catch (error: any) {
      this.logger.error(`Daily digest failed: ${error?.message || error}`);
    }
  }
}
