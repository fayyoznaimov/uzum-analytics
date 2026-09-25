import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { IntegrationsService } from './integrations.service';

class SaveIntegrationDto {
  @IsOptional() @IsString() @MaxLength(4000) token?: string;
  @IsOptional() @IsString() @MaxLength(100) shopId?: string;
  @IsOptional() @IsString() @MaxLength(100) chatId?: string;
  @IsOptional() @IsString() @MaxLength(200) shopName?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsIn(['openclaw', 'api']) provider?: string;
  @IsOptional() @IsString() @MaxLength(100) openclawModel?: string;
  @IsOptional() @IsBoolean() autoReplyEnabled?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) dailyDigestTime?: string;
  @IsOptional() @IsBoolean() notifyNewOrders?: boolean;
  @IsOptional() @IsBoolean() notifyLowStock?: boolean;
  @IsOptional() @IsBoolean() notifyGoals?: boolean;
  @IsOptional() @IsBoolean() notifyErrors?: boolean;
  @IsOptional() @IsBoolean() notifySupplyStatus?: boolean;
  @IsOptional() @IsBoolean() notifySlotFound?: boolean;
  @IsOptional() @IsBoolean() notifyDailyDigest?: boolean;
}

@UseGuards(AuthGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private service: IntegrationsService) {}
  @Get() list() { return this.service.list(); }
  @Post('telegram/test-latest-order') testLatestOrder() { return this.service.testLatestOrderNotification(); }
  @Post('telegram/menu') telegramMenu() { return this.service.sendTelegramMenu(); }
  @Put(':type') save(@Param('type') type: string, @Body() dto: SaveIntegrationDto) { return this.service.save(type, dto); }
  @Post(':type/test') test(@Param('type') type: string, @Body() dto: SaveIntegrationDto) { return this.service.test(type, dto); }
}
