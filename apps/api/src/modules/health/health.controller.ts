import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: 'uzum-analytics-api', version: '1.0.6', time: new Date().toISOString() };
  }
}
