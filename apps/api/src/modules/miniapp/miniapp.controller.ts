import { Controller, Get, Headers, Query } from '@nestjs/common';
import { MiniAppService } from './miniapp.service';

/** Эндпоинт мини-приложения Telegram: вместо JWT — подписанный initData в заголовке. */
@Controller('miniapp')
export class MiniAppController {
  constructor(private readonly service: MiniAppService) {}
  @Get('summary')
  summary(@Headers('x-telegram-init-data') initData?: string, @Query('period') period?: string) {
    return this.service.summary(initData, period);
  }
}
