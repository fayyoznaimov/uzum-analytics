import { Body, Controller, Delete, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CompetitorsService } from './competitors.service';

@UseGuards(AuthGuard)
@Controller('competitors')
export class CompetitorsController {
  constructor(private readonly service: CompetitorsService) {}
  @Get() list() { return this.service.list(); }
  @Post() add(@Body() body: { url: string; note?: string }) { return this.service.add(body?.url, body?.note); }
  @Delete(':id') remove(@Param('id') id: string) { return this.service.remove(id); }
  @Get('positions') positions() { return this.service.positions(); }
  @Post('pairing-code') pairingCode() { return this.service.createPairingCode(); }
}

/** Эндпоинты Chrome-расширения: вместо JWT — парный токен в заголовке. */
@Controller('competitor-watch')
export class CompetitorWatchController {
  constructor(private readonly service: CompetitorsService) {}
  @Post('pair') pair(@Body() body: { code: string }) { return this.service.pair(body?.code); }
  @Get('targets') targets(@Headers('x-watch-token') token?: string) { return this.service.targets(token); }
  @Post('ingest') ingest(@Headers('x-watch-token') token: string | undefined, @Body() body: any) { return this.service.ingest(token, body); }
}
