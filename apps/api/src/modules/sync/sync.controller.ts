import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { SyncService } from './sync.service';

@UseGuards(AuthGuard)
@Controller('sync')
export class SyncController {
  constructor(private service: SyncService) {}
  @Post('run') run() { return this.service.start(); }
  @Get('runs') runs() { return this.service.runs(); }
}
