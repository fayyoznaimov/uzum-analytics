/**
 * Вход в кабинет продавца Uzum под отдельным сотрудником и продление сессии —
 * так же, как это делает сам кабинет в браузере (seller.uzum.uz, модуль авторизации):
 *
 *   POST https://api-seller.uzum.uz/api/oauth/token
 *   Authorization: Basic <публичный ключ клиента кабинета b2b-front>
 *   Content-Type: application/x-www-form-urlencoded
 *     grant_type=password&username=<телефон или e-mail>&password=<пароль>&referer=
 *     grant_type=refresh_token&refresh_token=<refresh>
 *   → { access_token, refresh_token, expires_in }
 *
 * access_token кладётся туда же, где раньше лежал вставленный вручную токен
 * (интеграция UZUM_INTERNAL), — отзывы, акции и реклама читают его как прежде.
 *
 * Модуль чистый: формирование запросов и решения, без сети и базы.
 */

export const CABINET_OAUTH_URL = 'https://api-seller.uzum.uz/api/oauth/token';
/** Публичный ключ клиента кабинета («b2b-front:clientSecret»), зашит в код seller.uzum.uz. */
export const CABINET_CLIENT_BASIC = 'YjJiLWZyb250OmNsaWVudFNlY3JldA==';
/** Продлеваем заранее: если до истечения меньше этого — пора. */
export const CABINET_REFRESH_MARGIN_MS = 60 * 60_000;

export type CabinetTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date | null };

export function passwordGrantBody(username: string, password: string): string {
  return `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&referer=`;
}

export function refreshGrantBody(refreshToken: string): string {
  return `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
}

/**
 * Варианты логина для входа. E-mail — как есть. Телефон кабинет принимает
 * в одном из видов, какой именно — не зафиксировано, поэтому пробуем по очереди:
 * «998XXXXXXXXX», «+998XXXXXXXXX» и как ввёл владелец.
 */
export function usernameVariants(login: string): string[] {
  const raw = String(login || '').trim();
  if (!raw) return [];
  if (raw.includes('@')) return [raw.toLowerCase()];
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 9) digits = '998' + digits;
  const variants = digits ? [digits, '+' + digits, raw] : [raw];
  return [...new Set(variants)];
}

/** Ответ /oauth/token → токены. Незнакомая форма — ошибка, а не пустой токен. */
export function parseTokenResponse(body: any, now: Date = new Date()): CabinetTokens {
  const data = body?.access_token ? body : body?.payload?.access_token ? body.payload : null;
  if (!data) throw new Error('oauth/token: в ответе нет access_token');
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000) : null,
  };
}

/** Пора продлевать: срок неизвестен, уже истёк или истекает в пределах запаса. */
export function needsRefresh(expiresAt: Date | string | null | undefined, now: Date = new Date(), marginMs = CABINET_REFRESH_MARGIN_MS): boolean {
  if (!expiresAt) return true;
  const at = new Date(expiresAt).getTime();
  if (!Number.isFinite(at)) return true;
  return at - now.getTime() <= marginMs;
}

/** Понятный текст ошибки входа; пароль и токены в текст не попадают. */
export function cabinetAuthErrorMessage(status: number, body: any): string {
  const nested = (() => { try { return JSON.parse(body?.errors?.[0]?.detailMessage || body?.error || '{}'); } catch { return {}; } })();
  const code = nested?.error || body?.errors?.[0]?.code || '';
  const description = nested?.error_description || body?.errors?.[0]?.message || body?.message || '';
  if (/invalid_grant/i.test(code) && /bad credentials|password|учетн|учётн/i.test(description)) return 'Неверный логин или пароль сотрудника';
  if (/invalid_grant/i.test(code) && /refresh/i.test(description)) return 'Refresh-токен недействителен';
  if (status === 401 || status === 403) return `Кабинет отклонил вход (HTTP ${status})${description ? ` — ${description}` : ''}`;
  return `oauth/token: HTTP ${status}${description ? ` — ${description}` : code ? ` — ${code}` : ''}`;
}
