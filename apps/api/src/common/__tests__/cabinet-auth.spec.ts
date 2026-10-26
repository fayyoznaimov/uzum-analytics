import { describe, expect, it } from 'vitest';
import {
  authFailureUrgent,
  CABINET_CLIENT_BASIC,
  cabinetAuthErrorMessage,
  needsRefresh,
  refreshDue,
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

  it('продлевает за неделю до конца, при неудаче — не чаще раза в 6 часов; в последний час — каждый запуск', () => {
    const now = new Date('2026-10-26T08:00:00Z');
    const expires = '2026-10-30T08:11:57Z';
    expect(refreshDue({ accessExpiresAt: '2026-11-25T08:00:00Z' }, now)).toBe(false);
    expect(refreshDue({ accessExpiresAt: expires }, now)).toBe(true);
    expect(refreshDue({ accessExpiresAt: expires, lastAttemptAt: '2026-10-26T03:00:00Z' }, now)).toBe(false);
    expect(refreshDue({ accessExpiresAt: expires, lastAttemptAt: '2026-10-26T01:59:00Z' }, now)).toBe(true);
    expect(refreshDue({ accessExpiresAt: '2026-10-26T08:30:00Z', lastAttemptAt: '2026-10-26T07:40:00Z' }, now)).toBe(true);
    expect(refreshDue({ accessExpiresAt: null, lastAttemptAt: '2026-10-26T07:40:00Z' }, now)).toBe(true);
  });

  it('пишет владельцу о неудачном продлении, только когда до конца сессии меньше двух суток', () => {
    const now = new Date('2026-10-26T08:00:00Z');
    expect(authFailureUrgent('2026-10-30T08:11:57Z', now)).toBe(false);
    expect(authFailureUrgent('2026-10-28T07:00:00Z', now)).toBe(true);
    expect(authFailureUrgent('2026-10-20T00:00:00Z', now)).toBe(true);
    expect(authFailureUrgent(null, now)).toBe(true);
  });

  it('turns oauth errors into clear Russian messages without secrets', () => {
    const body = (description: string) => ({ errors: [{ code: 'bad-request-001', detailMessage: JSON.stringify({ error: 'invalid_grant', error_description: description }) }] });
    expect(cabinetAuthErrorMessage(400, body('Bad credentials'))).toBe('Неверный логин или пароль сотрудника');
    expect(cabinetAuthErrorMessage(400, body('Invalid refresh token'))).toBe('Refresh-токен недействителен');
    expect(cabinetAuthErrorMessage(401, {})).toBe('Кабинет отклонил вход (HTTP 401)');
    expect(cabinetAuthErrorMessage(500, { message: 'oops' })).toBe('oauth/token: HTTP 500 — oops');
  });

  it('страница Cloudflare вместо JSON — понятный текст, без HTML', () => {
    const cloudflare = { message: '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' };
    expect(cabinetAuthErrorMessage(403, cloudflare)).toBe('Cloudflare не пустил сервер ко входу в кабинет (HTTP 403, проверка «Just a moment…») — повторим позже');
    expect(cabinetAuthErrorMessage(502, { message: '<html><body>Bad gateway</body></html>' })).toBe('oauth/token: HTTP 502 — кабинет ответил HTML-страницей вместо JSON');
  });
});
