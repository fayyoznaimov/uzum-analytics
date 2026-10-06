import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { AutoBidderService } from './auto-bidder.service';

class PolicyDto {
  @IsString() campaignId!: string;
  @IsString() skuGroupId!: string;
  @IsString() query!: string;
  @IsInt() @Min(10) @Max(100) targetReach!: number;
  @IsInt() @Min(1) maxBid!: number;
  @Transform(({ value }) => (value === '' || value === undefined ? null : value))
  @ValidateIf((_, value) => value !== null) @IsNumber() @Min(0.1) @Max(100) maxDrr!: number | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class RunDto { @IsOptional() @IsBoolean() apply?: boolean; }

@UseGuards(AuthGuard)
@Controller('ads/auto-bidder')
export class AdsController {
  constructor(private readonly autoBidder: AutoBidderService) {}
  @Get('campaigns') campaigns() { return this.autoBidder.campaigns(); }
  @Get('campaigns/:id/keywords') keywords(@Param('id') id: string) { return this.autoBidder.keywords(id); }
  @Put('keywords/:adId') upsert(@Param('adId') adId: string, @Body() dto: PolicyDto) { return this.autoBidder.upsertPolicy(adId, { ...dto, maxDrr: dto.maxDrr ?? null }); }
  @Delete('keywords/:adId') disable(@Param('adId') adId: string) { return this.autoBidder.disablePolicy(adId); }
  @Get('changes') changes(@Query('limit') limit?: string) { return this.autoBidder.changes(Number(limit) || 100); }
  @Post('run') run(@Body() dto: RunDto) { return this.autoBidder.run({ apply: Boolean(dto.apply), notify: false }); }
}
