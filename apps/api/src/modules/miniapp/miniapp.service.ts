import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { IntegrationType } from '@prisma/client';
import { tashkentKey } from '../../common/period';
import { buildMiniAppSummary, miniAppRange, normalizeMiniAppPeriod, verifyInitData } from '../../common/telegram-miniapp';
import { DashboardService } from '../dashboard/dashboard.service';
import { IntegrationsService } from '../integrations/integrations.service';

/**
 * Мини-приложение Telegram: один read-only эндпоинт сводки за период.
 * Доступ не по JWT, а по подписи initData токеном бота; дополнительно
 * проверяется, что открывает его владелец — тот же Telegram-аккаунт, в чат
 * которого бот пишет отчёты (metadata.chatId), либо id из
 * TELEGRAM_MINIAPP_USER_IDS в .env.
 */
@Injectable()
export class MiniAppService {
  private readonly logger = new Logger(MiniAppService.name);
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly dashboard: DashboardService,
  ) {}

  private allowedUserIds(chatId: string) {
    const extra = String(process.env.TELEGRAM_MINIAPP_USER_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return new Set([chatId, ...extra].filter(Boolean));
  }

  async summary(initData: string | undefined, period: string | undefined, client?: string) {
    const clientInfo = client ? ` [клиент: ${String(client).slice(0, 200)}]` : '';
    const stored = await this.integrations.getPlain(IntegrationType.TELEGRAM);
    const token = stored?.token;
    const chatId = String(stored?.metadata?.chatId || '');
    if (!token) throw new UnauthorizedException('Telegram-бот не настроен');
    let user;
    try {
      user = verifyInitData(String(initData || ''), token);
    } catch (error: any) {
      this.logger.warn(`Мини-приложение: отказ — ${error?.message || error}${clientInfo}`);
      throw new UnauthorizedException(String(error?.message || 'Не удалось проверить данные Telegram'));
    }
    const allowed = this.allowedUserIds(chatId);
    if (allowed.size && !allowed.has(user.id)) {
      this.logger.warn(`Мини-приложение: Telegram-аккаунт ${user.id} не в списке разрешённых${clientInfo}`);
      throw new UnauthorizedException('Этот Telegram-аккаунт не имеет доступа к отчётам магазина');
    }
    const key = normalizeMiniAppPeriod(period);
    const range = miniAppRange(key, tashkentKey(new Date()));
    const overview = await this.dashboard.overview({ from: range.from, to: range.to, compare: 'false' });
    return buildMiniAppSummary(overview, { key, ...range });
  }
}
