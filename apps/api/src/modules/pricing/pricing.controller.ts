import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { PricingService } from './pricing.service';
import { PromoPricingService } from './promo-pricing.service';

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

class SendPromoPriceDto {
  @IsInt() @Min(1) price!: number;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsInt() @Min(1) saleId?: number;
  @IsOptional() @IsInt() @Min(1) minPrice?: number;
  @IsOptional() @IsNumber() @Min(0.1) @Max(50) maxStepPercent?: number;
  @IsOptional() @IsString() reason?: string;
}

@UseGuards(AuthGuard)
@Controller('pricing')
export class PricingController {
  constructor(private readonly service: PricingService, private readonly promo: PromoPricingService) {}
  @Post('skus/:skuId/price') sendPrice(@Param('skuId') skuId: string, @Body() dto: SendPriceDto) {
    const { price, ...options } = dto;
    return this.service.sendPrice(skuId, price, options);
  }
  @Get('changes') changes(@Query('skuId') skuId?: string, @Query('limit') limit?: string, @Query('kind') kind?: string) { return this.service.changes(skuId, Number(limit) || 50, kind); }
  @Get('promo') promoPrices(@Query('skuId') skuId?: string) { return this.promo.promoPrices(skuId); }
  @Post('promo/skus/:skuId/price') sendPromoPrice(@Param('skuId') skuId: string, @Body() dto: SendPromoPriceDto) {
    const { price, ...options } = dto;
    return this.promo.sendPromoPrice(skuId, price, options);
  }
}
