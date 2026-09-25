import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from './common/prisma.service';
import { CryptoService } from './common/crypto.service';
import { OpenclawClient } from './common/openclaw.client';
import { TelegramClient } from './common/telegram.client';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { AuthGuard } from './modules/auth/auth.guard';
import { IntegrationsController } from './modules/integrations/integrations.controller';
import { IntegrationsService } from './modules/integrations/integrations.service';
import { CostsController } from './modules/costs/costs.controller';
import { CostsService } from './modules/costs/costs.service';
import { GoalsController } from './modules/goals/goals.controller';
import { GoalsService } from './modules/goals/goals.service';
import { DashboardController } from './modules/dashboard/dashboard.controller';
import { DashboardService } from './modules/dashboard/dashboard.service';
import { ProductsController } from './modules/products/products.controller';
import { ProductsService } from './modules/products/products.service';
import { SyncController } from './modules/sync/sync.controller';
import { SyncService } from './modules/sync/sync.service';
import { SuppliesController } from './modules/supplies/supplies.controller';
import { SuppliesService } from './modules/supplies/supplies.service';
import { WarehouseController } from './modules/warehouse/warehouse.controller';
import { WarehouseService } from './modules/warehouse/warehouse.service';
import { DigestService } from './modules/notifications/digest.service';
import { HealthController } from './modules/health/health.controller';
import { ReviewsController } from './modules/reviews/reviews.controller';
import { ReviewsService } from './modules/reviews/reviews.service';
import { FinancialStatementsController } from './modules/financial-statements/financial-statements.controller';
import { FinancialStatementsService } from './modules/financial-statements/financial-statements.service';
import { PricingController } from './modules/pricing/pricing.controller';
import { PricingService } from './modules/pricing/pricing.service';
import { PromoPricingService } from './modules/pricing/promo-pricing.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '12h' },
      }),
    }),
  ],
  controllers: [
    HealthController, AuthController, IntegrationsController, CostsController, GoalsController,
    DashboardController, ProductsController, SyncController, SuppliesController, WarehouseController, ReviewsController,
    FinancialStatementsController, PricingController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    PrismaService, CryptoService, TelegramClient, OpenclawClient, AuthService, AuthGuard, IntegrationsService,
    CostsService, GoalsService, DashboardService, ProductsService, SyncService, SuppliesService,
    WarehouseService, DigestService, ReviewsService, FinancialStatementsService, PricingService, PromoPricingService,
  ],
})
export class AppModule {}
