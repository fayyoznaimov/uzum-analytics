import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { PriceExperimentService } from './price-experiment.service';

/** Внешние рекламные кампании (Instagram, Telegram, блогеры) и их оценка через 7 дней. */
@UseGuards(AuthGuard)
@Controller('marketing-experiments')
export class MarketingController {
  constructor(private readonly service: PriceExperimentService) {}
  @Get() list() { return this.service.listMarketing(); }
  @Post() add(@Body() body: { channel: string; productExternalId: string; startDate: string; budget?: number | null; note?: string | null }) { return this.service.addMarketing(body); }
  @Delete(':id') remove(@Param('id') id: string) { return this.service.removeMarketing(id); }
}
