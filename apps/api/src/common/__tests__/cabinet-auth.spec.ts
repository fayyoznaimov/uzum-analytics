import { describe, expect, it } from 'vitest';
import {
  CABINET_CLIENT_BASIC,
  cabinetAuthErrorMessage,
  needsRefresh,
  parseTokenResponse,
  passwordGrantBody,
  refreshGrantBody,
  usernameVariants,
} from '../cabinet-auth';

describe('cabinet-auth', () => {
  it('uses the public cabinet client key b2b-front', () => {
    expect(Buffer.from(CABINET_CLIENT_BASIC, 'base64').toString()).toBe('b2b-front:clientSecret');
  });

  it('builds form bodies like the cabinet does, escaping special characters', () => {
    expect(passwordGrantBody('998901234567', 'p@ss&word=1')).toBe('grant_type=password&username=998901234567&password=p%40ss%26word%3D1&referer=');
    expect(refreshGrantBody('abc.def+g')).toBe('grant_type=refresh_token&refresh_token=abc.def%2Bg');
  });

  it('tries phone variants and keeps e-mail as is', () => {
    expect(usernameVariants('+998 (90) 123-45-67')).toEqual(['998901234567', '+998901234567', '+998 (90) 123-45-67']);
    expect(usernameVariants('901234567')).toEqual(['998901234567', '+998901234567', '901234567']);
    expect(usernameVariants('Bot@Shop.uz ')).toEqual(['bot@shop.uz']);
    expect(usernameVariants('  ')).toEqual([]);
  });

  it('parses the token response and computes expiry', () => {
    const now = new Date('2026-09-30T10:00:00Z');
    expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, now)).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date('2026-09-30T11:00:00Z') });
    expect(parseTokenResponse({ payload: { access_token: 'a' } }, now)).toEqual({ accessToken: 'a', refreshToken: null, expiresAt: null });
    expect(() => parseTokenResponse({ payload: null })).toThrow();
  });

  it('refreshes when expiry is unknown, past or within the margin', () => {
    const now = new Date('2026-09-30T10:00:00Z');
    expect(needsRefresh(null, now)).toBe(true);
    expect(needsRefresh('garbage', now)).toBe(true);
    expect(needsRefresh('2026-09-30T10:59:00Z', now)).toBe(true);
    expect(needsRefresh('2026-09-30T12:00:00Z', now)).toBe(false);
  });

  it('turns oauth errors into clear Russian messages without secrets', () => {
    const body = (description: string) => ({ errors: [{ code: 'bad-request-001', detailMessage: JSON.stringify({ error: 'invalid_grant', error_description: description }) }] });
    expect(cabinetAuthErrorMessage(400, body('Bad credentials'))).toBe('Неверный логин или пароль сотрудника');
    expect(cabinetAuthErrorMessage(400, body('Invalid refresh token'))).toBe('Refresh-токен недействителен');
    expect(cabinetAuthErrorMessage(401, {})).toBe('Кабинет отклонил вход (HTTP 401)');
    expect(cabinetAuthErrorMessage(500, { message: 'oops' })).toBe('oauth/token: HTTP 500 — oops');
  });
});
