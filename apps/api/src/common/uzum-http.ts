/**
 * Общий HTTP-клиент Uzum. Раньше почти идентичный fetch-код жил пятью копиями
 * в sync/pricing/promo-pricing/supplies/integrations — здесь общая механика
 * (сборка URL, таймаут через AbortController, разбор JSON, цикл повторов),
 * а ОСОЗНАННО разные политики сервисов переданы параметрами и остались как были:
 *  - sync повторяет 429/5xx и задокументированные 403/404-флапы финансовых путей;
 *  - pricing/promo-pricing повторяют ТОЛЬКО 429 — после POST с 5xx цена могла
 *    уже примениться, повтор решает человек;
 *  - supplies повторяет 429/5xx двумя быстрыми попытками;
 *  - integrations вообще не повторяет (однократная проверка токена).
 */

export const UZUM_OPENAPI_BASE = 'https://api-seller.uzum.uz/api/seller-openapi';

export type UzumQueryValue = string | number | boolean | Array<string | number | boolean> | null | undefined;

export type UzumRetryPolicy = {
  /** Максимум повторов сверх первой попытки. */
  attempts: number;
  shouldRetry: (status: number, path: string) => boolean;
  backoffMs: (status: number, attempt: number) => number;
  /** null — повторять молча (политика supplies). */
  warn?: ((message: string) => void) | null;
};

export type UzumRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT';
  /** База URL; абсолютный https-путь в `path` имеет приоритет. */
  base?: string;
  token: string;
  /** true — `Authorization: Bearer <token>` (кабинетный API), иначе сырой токен (OpenAPI). */
  bearer?: boolean;
  params?: Record<string, UzumQueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: UzumRetryPolicy | null;
  /**
   * Построить ошибку по не-OK ответу (после исчерпания повторов). Может быть
   * асинхронным (promo-pricing по 401 помечает интеграцию ERROR). Если не задан —
   * стандартное сообщение с деталью из тела ответа.
   */
  buildError?: (status: number, body: any, rawText: string, path: string) => Error | Promise<Error>;
};

export function uzumErrorDetail(body: any): string | undefined {
  return body?.message || body?.error || body?.errors?.[0]?.message || body?.payload?.[0]?.msg;
}

export async function uzumRequest(path: string, options: UzumRequestOptions): Promise<any> {
  const {
    method = 'GET', base = UZUM_OPENAPI_BASE, token, bearer = false, params, body,
    headers = {}, timeoutMs = 30_000, retry = null, buildError,
  } = options;
  const retryAttempts = retry?.attempts ?? 0;
  for (let attempt = 0; ; attempt++) {
    const url = new URL(/^https:\/\//.test(path) ? path : base + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.append(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: bearer ? `Bearer ${token}` : token,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const rawText = await response.text();
      let parsed: any = {};
      try { parsed = rawText ? JSON.parse(rawText) : {}; } catch { parsed = { raw: rawText.slice(0, 500) }; }
      if (response.ok) return parsed;
      if (retry && attempt < retryAttempts && retry.shouldRetry(response.status, path)) {
        const backoffMs = retry.backoffMs(response.status, attempt);
        retry.warn?.(`${path}: HTTP ${response.status}, повтор через ${Math.round(backoffMs / 1000)} с (попытка ${attempt + 1} из ${retryAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      if (buildError) throw await buildError(response.status, parsed, rawText, path);
      const detail = uzumErrorDetail(parsed);
      throw new Error(`${path}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error(`${path}: превышено время ожидания ${Math.round(timeoutMs / 1000)} секунд`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
