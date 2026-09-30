import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationStatus, IntegrationType, Prisma } from '@prisma/client';
import {
  CABINET_CLIENT_BASIC,
  CABINET_OAUTH_URL,
  CabinetTokens,
  cabinetAuthErrorMessage,
  needsRefresh,
  parseTokenResponse,
  passwordGrantBody,
  refreshGrantBody,
  usernameVariants,
} from '../../common/cabinet-auth';
import { CryptoService } from '../../common/crypto.service';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from './integrations.service';

type LoginSecret = { password: string; refreshToken: string | null };
type LoginMetadata = { username?: string; usernameUsed?: string; accessExpiresAt?: string | null; lastRefreshAt?: string; lastNotifiedAt?: string };

export type CabinetAuthResult = { ok: boolean; action: 'none' | 'fresh' | 'refresh' | 'login'; expiresAt?: string | null; error?: string };

/** Не чаще одного сообщения об ошибке входа в Telegram за это время. */
const NOTIFY_EVERY_MS = 3 * 60 * 60_000;

/**
 * Сессия кабинета Uzum под отдельным сотрудником: сервер сам входит и продлевает
 * токен, владельцу больше не нужно вставлять его вручную. Логин — в metadata,
 * пароль и refresh-токен — в зашифрованном секрете интеграции UZUM_CABINET_LOGIN.
 * Свежий access-токен записывается в UZUM_INTERNAL, откуда его читают отзывы, акции и реклама.
 */
@Injectable()
export class CabinetAuthService {
  private readonly logger = new Logger(CabinetAuthService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Cron(process.env.CABINET_AUTH_CRON || '0 */20 * * * *')
  async scheduled() {
    await this.refreshIfNeeded().catch((error) => this.logger.error(`Продление сессии кабинета: ${String(error?.message || error)}`));
  }

  async saveLogin(username: string, password: string): Promise<CabinetAuthResult> {
    const login = String(username || '').trim();
    if (!login || !password) throw new BadRequestException('Укажите логин и пароль сотрудника');
    const secret: LoginSecret = { password, refreshToken: null };
    const metadata: LoginMetadata = { username: login };
    await this.prisma.integrationCredential.upsert({
      where: { type: IntegrationType.UZUM_CABINET_LOGIN },
      update: { ...this.crypto.encrypt(JSON.stringify(secret)), metadata: metadata as Prisma.InputJsonValue, enabled: true, status: IntegrationStatus.NOT_CONFIGURED, lastError: null },
      create: { type: IntegrationType.UZUM_CABINET_LOGIN, ...this.crypto.encrypt(JSON.stringify(secret)), metadata: metadata as Prisma.InputJsonValue, enabled: true },
    });
    const result = await this.refreshIfNeeded(true);
    if (!result.ok) throw new BadRequestException(result.error || 'Не удалось войти в кабинет под сотрудником');
    return result;
  }

  /** Продлевает сессию, если она истекает в пределах часа (или force). Сначала refresh-токеном, затем паролем. */
  async refreshIfNeeded(force = false): Promise<CabinetAuthResult> {
    if (this.running) return { ok: true, action: 'none' };
    this.running = true;
    try {
      const row = await this.prisma.integrationCredential.findUnique({ where: { type: IntegrationType.UZUM_CABINET_LOGIN } });
      if (!row || !row.enabled) return { ok: false, action: 'none', error: 'Вход под сотрудником не настроен' };
      const metadata = (row.metadata || {}) as LoginMetadata;
      let secret: LoginSecret;
      try {
        secret = JSON.parse(this.crypto.decrypt(row) || '{}');
      } catch {
        return this.fail(row.id, metadata, 'Не удалось расшифровать логин сотрудника — сохраните его заново');
      }
      if (!force && !needsRefresh(metadata.accessExpiresAt)) return { ok: true, action: 'fresh', expiresAt: metadata.accessExpiresAt ?? null };

      const errors: string[] = [];
      let tokens: CabinetTokens | null = null;
      let action: CabinetAuthResult['action'] = 'refresh';
      if (secret.refreshToken) {
        try {
          tokens = await this.grant(refreshGrantBody(secret.refreshToken));
        } catch (error: any) {
          errors.push(String(error?.message || error));
        }
      }
      let usernameUsed = metadata.usernameUsed;
      if (!tokens) {
        action = 'login';
        const variants = usernameVariants(metadata.username || '');
        const ordered = usernameUsed && variants.includes(usernameUsed) ? [usernameUsed, ...variants.filter((v) => v !== usernameUsed)] : variants;
        for (const username of ordered) {
          try {
            tokens = await this.grant(passwordGrantBody(username, secret.password));
            usernameUsed = username;
            break;
          } catch (error: any) {
            errors.push(String(error?.message || error));
          }
        }
      }
      if (!tokens) return this.fail(row.id, metadata, [...new Set(errors)].join('; ') || 'Кабинет не выдал токен');

      const expiresAt = tokens.expiresAt ? tokens.expiresAt.toISOString() : null;
      await this.storeAccessToken(tokens.accessToken, expiresAt);
      const nextSecret: LoginSecret = { password: secret.password, refreshToken: tokens.refreshToken ?? secret.refreshToken ?? null };
      const nextMetadata: LoginMetadata = { ...metadata, usernameUsed, accessExpiresAt: expiresAt, lastRefreshAt: new Date().toISOString() };
      await this.prisma.integrationCredential.update({
        where: { id: row.id },
        data: { ...this.crypto.encrypt(JSON.stringify(nextSecret)), metadata: nextMetadata as Prisma.InputJsonValue, status: IntegrationStatus.CONNECTED, lastError: null, lastTestedAt: new Date() },
      });
      this.logger.log(`Сессия кабинета: ${action === 'login' ? 'вход под сотрудником' : 'продлена'}, действует до ${expiresAt ?? 'неизвестно'}`);
      return { ok: true, action, expiresAt };
    } finally {
      this.running = false;
    }
  }

  private async grant(body: string): Promise<CabinetTokens> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(CABINET_OAUTH_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${CABINET_CLIENT_BASIC}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text.slice(0, 200) }; }
      if (!response.ok) throw new Error(cabinetAuthErrorMessage(response.status, parsed));
      return parseTokenResponse(parsed);
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error('oauth/token: превышено время ожидания 20 секунд');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Записывает access-токен туда, откуда его читают отзывы, акции и реклама (UZUM_INTERNAL). */
  private async storeAccessToken(accessToken: string, expiresAt: string | null) {
    const current = await this.prisma.integrationCredential.findUnique({ where: { type: IntegrationType.UZUM_INTERNAL } });
    const seller = await this.prisma.integrationCredential.findUnique({ where: { type: IntegrationType.UZUM } });
    const previous = (current?.metadata || {}) as Record<string, any>;
    const shopId = previous.shopId || ((seller?.metadata || {}) as Record<string, any>).shopId || null;
    const metadata = { ...previous, shopId, accessExpiresAt: expiresAt, source: 'employee' } as Prisma.InputJsonValue;
    const secret = this.crypto.encrypt(accessToken);
    await this.prisma.integrationCredential.upsert({
      where: { type: IntegrationType.UZUM_INTERNAL },
      update: { ...secret, metadata, enabled: true, status: IntegrationStatus.CONNECTED, lastError: null, lastTestedAt: new Date() },
      create: { type: IntegrationType.UZUM_INTERNAL, ...secret, metadata, enabled: true, status: IntegrationStatus.CONNECTED, lastTestedAt: new Date() },
    });
  }

  private async fail(id: string, metadata: LoginMetadata, error: string): Promise<CabinetAuthResult> {
    this.logger.warn(`Вход в кабинет под сотрудником не удался: ${error}`);
    const now = Date.now();
    const lastNotified = metadata.lastNotifiedAt ? new Date(metadata.lastNotifiedAt).getTime() : 0;
    const notify = !lastNotified || now - lastNotified > NOTIFY_EVERY_MS;
    await this.prisma.integrationCredential.update({
      where: { id },
      data: {
        status: IntegrationStatus.ERROR,
        lastError: error.slice(0, 500),
        lastTestedAt: new Date(),
        metadata: (notify ? { ...metadata, lastNotifiedAt: new Date(now).toISOString() } : metadata) as Prisma.InputJsonValue,
      },
    });
    if (notify) {
      await this.integrations.notifyTelegram(`⚠️ Не удалось продлить сессию кабинета Uzum под сотрудником: ${error}. Проверьте логин и пароль в Настройки → Отзывы Uzum.`).catch(() => false);
    }
    return { ok: false, action: 'none', error };
  }
}
