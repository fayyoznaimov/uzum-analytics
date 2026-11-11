import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { parseCabinetBalance, type CabinetBalance } from '../../common/cabinet-balance';
import { PrismaService } from '../../common/prisma.service';
import { PromoPricingService } from '../pricing/promo-pricing.service';

const FINANCE = 'https://api-seller.uzum.uz/api/v1/seller/finance';

/**
 * Снимок «К выплате» и «Общий баланс» из кабинета Uzum → CabinetBalanceSnapshot (один на магазин).
 * Главная и Кошелёк показывают «Можно вывести» по этому снимку, пока он свежий (common/cabinet-balance.ts);
 * ошибка кабинета (Cloudflare, токен) снимок не трогает — через 6 часов экран сам переходит на наш расчёт.
 */
@Injectable()
export class CabinetBalanceService {
  private readonly logger = new Logger(CabinetBalanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cabinet: PromoPricingService,
  ) {}

  @Cron(process.env.CABINET_BALANCE_CRON || '*/15 * * * *', { name: 'cabinet-balance', timeZone: 'Asia/Tashkent' })
  async scheduled(): Promise<void> {
    if (process.env.CABINET_BALANCE_ENABLED === 'false') return;
    await this.refresh().catch((error: any) => this.logger.warn(`Баланс кабинета Uzum не обновлён: ${String(error?.message || error).slice(0, 200)}`));
  }

  /** Читает кабинет и сохраняет снимок; ошибку отдаёт наружу (скрипт сверки покажет её словами). */
  async refresh(): Promise<CabinetBalance & { fetchedAt: Date }> {
    const shopExternalId = await this.cabinet.cabinetShopId();
    const shop = await this.prisma.shop.findUnique({ where: { externalId: shopExternalId } }) ?? await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new Error('В базе нет магазина для баланса кабинета');
    const schedule = (await this.cabinet.cabinet('GET', `${FINANCE}/payout-schedule`, { shopIds: shopExternalId }, undefined, 'ru')).body;
    const balance = (await this.cabinet.cabinet('GET', `${FINANCE}/balance`, { shopIds: shopExternalId }, undefined, 'ru')).body;
    const parsed = parseCabinetBalance(schedule, balance);
    const fetchedAt = new Date();
    const data = { ...parsed, fetchedAt };
    await this.prisma.cabinetBalanceSnapshot.upsert({ where: { shopId: shop.id }, update: data, create: { shopId: shop.id, ...data } });
    return data;
  }
}
