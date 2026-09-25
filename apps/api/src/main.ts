import 'reflect-metadata';
import helmet from 'helmet';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function validateEnvironment() {
  const required = ['DATABASE_URL', 'JWT_SECRET', 'APP_ENCRYPTION_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Не настроены обязательные переменные: ${missing.join(', ')}`);
  if ((process.env.JWT_SECRET || '').length < 32) throw new Error('JWT_SECRET должен быть не короче 32 символов');
}

async function bootstrap() {
  validateEnvironment();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.setGlobalPrefix('api');
  app.use(helmet({ contentSecurityPolicy: false }));
  const allowedOrigins = (process.env.WEB_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  app.enableCors({
    // Раньше сюда пускало любое расширение Chrome — это было нужно аудиту РК,
    // который удалён. Оставлять нельзя: под это правило подходило вообще любое
    // установленное у пользователя расширение, а не только наше.
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) =>
      callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT || 4000), '0.0.0.0');
}

bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
