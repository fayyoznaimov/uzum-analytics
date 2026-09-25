import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { DashboardService } from './dashboard.service';

@UseGuards(AuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private service: DashboardService) {}
  @Get('overview')
  overview(@Query('from') from?: string,@Query('to') to?: string,@Query('compare') compare?: string,@Query('days') days?: string) {
    return this.service.overview({from,to,compare,days});
  }
}
