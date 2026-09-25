import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { SuppliesService } from './supplies.service';

class FindSlotsDto { @IsOptional() @IsString() dropOffPointId?: string; }
class WatchDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() dropOffPointId?: string;
}
class LogisticsCostDto { @IsNumber() @Min(0) amount!: number; }

@UseGuards(AuthGuard)
@Controller('supplies')
export class SuppliesController {
  constructor(private readonly service: SuppliesService) {}
  @Get() list(@Query('type') type?: string, @Query('status') status?: string) { return this.service.list(type, status); }
  @Post('sync') sync() { return this.service.sync(); }
  @Get('costing') costing() { return this.service.costing(); }
  @Post(':id/logistics-cost') logisticsCost(@Param('id') id: string, @Body() dto: LogisticsCostDto) { return this.service.saveLogisticsCost(id, dto.amount); }
  @Post(':id/summary') summary(@Param('id') id: string) { return this.service.formatFboSupplySummary(id); }
  @Get(':id/history') history(@Param('id') id: string) { return this.service.history(id); }
  @Post(':id/find-slots') findSlots(@Param('id') id: string, @Body() dto: FindSlotsDto) { return this.service.findSlots(id, dto.dropOffPointId); }
  @Post(':id/watch') watch(@Param('id') id: string, @Body() dto: WatchDto) { return this.service.setWatch(id, dto.enabled, dto.dropOffPointId); }
}
