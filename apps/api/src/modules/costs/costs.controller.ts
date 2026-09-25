import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthGuard } from '../auth/auth.guard';
import { CostsService } from './costs.service';

class CostItemDto {
  @IsString() skuId!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsNumber() @Min(0) packagingCost?: number;
  @IsOptional() @IsNumber() @Min(0) warehouseLogisticsCost?: number;
  @IsOptional() @IsNumber() @Min(0) additionalCost?: number;
}
class SaveCostsDto { @IsArray() @ValidateNested({ each: true }) @Type(() => CostItemDto) items!: CostItemDto[]; }
class FinancialSettingsDto {
  @IsNumber() @Min(0) @Max(100) taxPercent!: number;
  @IsNumber() @Min(0) @Max(100) marketplaceCommissionFallbackPercent!: number;
  @IsInt() @Min(0) @Max(90) payoutDelayDays!: number;
  @IsOptional() @IsString() @IsIn(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']) payoutSchedule?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(10) payoutServiceFeePercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10) urgentWithdrawalFeePercent?: number;
}

@UseGuards(AuthGuard)
@Controller('costs')
export class CostsController {
  constructor(private service: CostsService) {}
  @Get() list(@Query('search') search?: string) { return this.service.list(search); }
  @Get('settings') settings() { return this.service.getSettings(); }
  @Post('settings') saveSettings(@Body() dto: FinancialSettingsDto) { return this.service.saveSettings(dto); }
  @Post('bulk') save(@Body() dto: SaveCostsDto) { return this.service.saveBulk(dto.items); }
}
