/**
 * Пауза запросов в кабинет Uzum, пока Cloudflare не пускает сервер.
 *
 * С 11.11.2026 ~11:20 (распродажа 11.11) Cloudflare отвечает серверу на api-seller.uzum.uz/api/seller/* проверкой
 * «Just a moment…» (HTTP 403): браузер владельца её проходит сам, программа — нет. Официальный OpenAPI
 * (/api/seller-openapi) под проверкой не стоит. Сервер при этом продолжал стучаться в кабинет каждые 10–20 минут
 * из пяти сервисов (лестница, статус «Буста заказов», баланс, склад для возвратов, отзывы) — сотни запросов в час,
 * которые заведомо получают ту же проверку. Теперь после первого такого ответа запросы к этому хосту не уходят
 * 20 минут, после повторного — 40, дальше по 60; первый запрос после паузы — проба, успешный ответ снимает паузу.
 * Состояние в памяти процесса: перезапуск API начинает с чистого листа.
 */
export const CABINET_PAUSE_STEPS_MINUTES = [20, 40, 60];

export type CabinetBreakerState = { strikes: number; pausedUntil: number; since: number | null };

export const emptyBreakerState = (): CabinetBreakerState => ({ strikes: 0, pausedUntil: 0, since: null });

/** Ответ — страница проверки Cloudflare, а не ответ API. */
export function isCloudflareChallenge(text: string | null | undefined): boolean {
  return /just a moment|cf-chl|challenge-platform|cf_chl/i.test(String(text ?? ''));
}

export function breakerPaused(state: CabinetBreakerState, now: number): boolean {
  return now < state.pausedUntil;
}

/** Очередная проверка Cloudflare: пауза растёт 20 → 40 → 60 минут. */
export function breakerOnBlock(state: CabinetBreakerState, now: number): CabinetBreakerState {
  const step = CABINET_PAUSE_STEPS_MINUTES[Math.min(state.strikes, CABINET_PAUSE_STEPS_MINUTES.length - 1)];
  return { strikes: state.strikes + 1, pausedUntil: now + step * 60_000, since: state.since ?? now };
}

/** Кабинет ответил — пауза снята. */
export function breakerOnSuccess(): CabinetBreakerState {
  return emptyBreakerState();
}

const tashkentTime = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' });

/** Текст отказа без запроса: начинается так же, как ответ при живой проверке, чтобы журналы и оповещения не различали их. */
export function breakerMessage(state: CabinetBreakerState, path: string): string {
  const since = state.since === null ? '' : ` с ${tashkentTime(state.since)}`;
  return `Cloudflare не пускает сервер в кабинет Uzum${since} — пауза до ${tashkentTime(state.pausedUntil)}, запросы не отправляем; ${path}`;
}

/** Общее для процесса состояние по хостам: кабинет (PromoPricingService) и отзывы (ReviewsService) делят одну паузу. */
const registry = new Map<string, CabinetBreakerState>();
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** Текст отказа, если хост сейчас на паузе; иначе null — запрос можно отправлять. */
export function cabinetPaused(url: string, now = Date.now()): string | null {
  const state = registry.get(hostOf(url));
  return state && breakerPaused(state, now) ? breakerMessage(state, new URL(url).pathname) : null;
}

/** Пришла проверка Cloudflare: ставим (продлеваем) паузу, возвращаем её окончание. */
export function cabinetBlocked(url: string, now = Date.now()): number {
  const host = hostOf(url);
  const next = breakerOnBlock(registry.get(host) ?? emptyBreakerState(), now);
  registry.set(host, next);
  return next.pausedUntil;
}

/** Кабинет ответил. true — если до этого была пауза (стоит записать в журнал, что доступ вернулся). */
export function cabinetAnswered(url: string): boolean {
  const host = hostOf(url);
  const wasBlocked = (registry.get(host)?.strikes ?? 0) > 0;
  registry.delete(host);
  return wasBlocked;
}
