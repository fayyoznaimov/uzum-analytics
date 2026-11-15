import { describe, expect, it } from 'vitest';
import { breakerMessage, breakerOnBlock, breakerOnSuccess, breakerPaused, cabinetAnswered, cabinetBlocked, cabinetPaused, emptyBreakerState, isCloudflareChallenge } from '../cabinet-breaker';

const T0 = Date.parse('2026-11-15T07:30:00Z'); // 12:30 Ташкент
const MIN = 60_000;

describe('cabinet-breaker', () => {
  it('узнаёт страницу проверки Cloudflare и не путает её с ответом API', () => {
    expect(isCloudflareChallenge('<!DOCTYPE html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate">')).toBe(true);
    expect(isCloudflareChallenge('{"message":"Access denied"}')).toBe(false);
    expect(isCloudflareChallenge(undefined)).toBe(false);
  });

  it('пауза растёт 20 → 40 → 60 минут и дальше не растёт', () => {
    let state = breakerOnBlock(emptyBreakerState(), T0);
    expect(state.pausedUntil - T0).toBe(20 * MIN);
    expect(breakerPaused(state, T0 + 19 * MIN)).toBe(true);
    expect(breakerPaused(state, T0 + 20 * MIN)).toBe(false);
    state = breakerOnBlock(state, T0 + 20 * MIN);
    expect(state.pausedUntil - (T0 + 20 * MIN)).toBe(40 * MIN);
    state = breakerOnBlock(state, T0 + 60 * MIN);
    state = breakerOnBlock(state, T0 + 120 * MIN);
    expect(state.pausedUntil - (T0 + 120 * MIN)).toBe(60 * MIN);
    expect(state.since).toBe(T0);
  });

  it('ответ кабинета снимает паузу', () => {
    const state = breakerOnSuccess();
    expect(state).toEqual(emptyBreakerState());
    expect(breakerPaused(state, T0)).toBe(false);
  });

  it('текст отказа без запроса совпадает по началу с живой проверкой и называет время по Ташкенту', () => {
    const state = breakerOnBlock(emptyBreakerState(), T0);
    expect(breakerMessage(state, '/x')).toBe('Cloudflare не пускает сервер в кабинет Uzum с 12:30 — пауза до 12:50, запросы не отправляем; /x');
  });

  it('пауза общая для хоста: отзывы и лестница не ходят в кабинет, пока она идёт; другой хост не трогается', () => {
    const reviews = 'https://api-seller.uzum.uz/api/seller/product-reviews';
    const ladder = 'https://api-seller.uzum.uz/api/seller/advertising/leaderboard/sku-group/1?query=x';
    const cube = 'https://analytics-seller.uzum.uz/cubejs-api/v1/load';
    expect(cabinetPaused(ladder, T0)).toBeNull();
    cabinetBlocked(reviews, T0);
    expect(cabinetPaused(ladder, T0 + MIN)).toContain('Cloudflare не пускает сервер в кабинет Uzum с 12:30 — пауза до 12:50');
    expect(cabinetPaused(cube, T0 + MIN)).toBeNull();
    expect(cabinetPaused(ladder, T0 + 21 * MIN)).toBeNull();
    expect(cabinetAnswered(ladder)).toBe(true);
    expect(cabinetAnswered(ladder)).toBe(false);
  });
});
