import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { GoalMetric, GoalPeriod } from '@prisma/client';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { GoalsService } from './goals.service';

class GoalDto {
  @IsString() shopId!: string;
  @IsEnum(GoalMetric) metric!: GoalMetric;
  @IsEnum(GoalPeriod) period!: GoalPeriod;
  @IsNumber() @Min(0) targetValue!: number;
  @IsDateString() startAt!: string;
  @IsDateString() endAt!: string;
  @IsOptional() @IsString() note?: string;
}

@UseGuards(AuthGuard)
@Controller('goals')
export class GoalsController {
  constructor(private service: GoalsService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() dto: GoalDto) { return this.service.create(dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.service.remove(id); }
}
