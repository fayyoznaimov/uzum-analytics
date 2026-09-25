import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { PricingService } from './pricing.service';

class SendPriceDto {
  @IsInt() @Min(1) price!: number;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsInt() @Min(1) minPrice?: number;
  @IsOptional() @IsNumber() @Min(0.1) @Max(50) maxStepPercent?: number;
  @IsOptional() @IsInt() @Min(1) fullPrice?: number;
  @IsOptional() @IsBoolean() withSkuTitle?: boolean;
  @IsOptional() @IsBoolean() allowDuringPromo?: boolean;
  @IsOptional() @IsString() reason?: string;
}

@UseGuards(AuthGuard)
@Controller('pricing')
export class PricingController {
  constructor(private readonly service: PricingService) {}
  @Post('skus/:skuId/price') sendPrice(@Param('skuId') skuId: string, @Body() dto: SendPriceDto) {
    const { price, ...options } = dto;
    return this.service.sendPrice(skuId, price, options);
  }
  @Get('changes') changes(@Query('skuId') skuId?: string, @Query('limit') limit?: string) { return this.service.changes(skuId, Number(limit) || 50); }
}
