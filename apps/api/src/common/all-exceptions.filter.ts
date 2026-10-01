import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

/**
 * Глобальный обработчик ошибок: раньше необработанные исключения (в т.ч. ошибки
 * Prisma из GET-эндпоинтов) уходили клиенту дефолтным 500 без следа в логах.
 * HttpException проходит как есть, всё остальное логируется со стеком и
 * возвращается единым ответом без внутренних деталей.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) this.logger.error(`${request?.method} ${request?.url} → ${status}: ${exception.message}`);
      const body = exception.getResponse();
      return response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
    }
    const message = (exception as any)?.message || String(exception);
    this.logger.error(`${request?.method} ${request?.url} → 500: ${message}`, (exception as any)?.stack);
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Внутренняя ошибка сервера' });
  }
}
