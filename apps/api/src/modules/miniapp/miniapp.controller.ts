import { Controller, Get, Headers, Query } from '@nestjs/common';
import { MiniAppService } from './miniapp.service';

/** Эндпоинт мини-приложения Telegram: вместо JWT — подписанный initData в заголовке. */
@Controller('miniapp')
export class MiniAppController {
  constructor(private readonly service: MiniAppService) {}
  @Get('summary')
  summary(
    @Headers('x-telegram-init-data') initData?: string,
    @Query('period') period?: string,
    // Чем открыли и что увидел клиент — попадает в лог при отказе: иначе причину
    // «подписи нет» на чужом телефоне не разобрать.
    @Headers('x-miniapp-client') client?: string,
  ) {
    return this.service.summary(initData, period, client);
  }
}
