/**
 * Когда сообщать в Telegram о сбое задачи, которая идёт часто (синхронизация раз в 30 минут,
 * лестница ставок и авто-ставка раз в час).
 *
 * Uzum время от времени отвечает разовыми ошибками и через минуту снова работает:
 * 24–26.10.2026 `/v1/shops` трижды вернул «404 Seller with id … not found», а кабинет
 * ответил 401 на 3 из 13 запусков лестницы. Такие сбои проходят сами, и каждое сообщение
 * о них — шум. Поэтому:
 *  - сообщаем, когда сбой повторился `notifyAfter` раз подряд;
 *  - пока сбой длится, напоминаем не чаще раза в `repeatMs`;
 *  - после восстановления — одно сообщение «снова работает», только если о сбое сообщали.
 *
 * Модуль чистый: состояние хранит вызывающий сервис (в памяти; перезапуск API его сбрасывает).
 */

export type FailureStreak = { failures: number; since: number | null; notifiedAt: number | null };
export type FailureAlertPolicy = { notifyAfter: number; repeatMs: number };

export const FAILURE_ALERT_DEFAULTS: FailureAlertPolicy = { notifyAfter: 2, repeatMs: 6 * 60 * 60_000 };

export const emptyStreak = (): FailureStreak => ({ failures: 0, since: null, notifiedAt: null });

/**
 * Ещё один сбой подряд: новое состояние и нужно ли сообщить сейчас. Отметку «сообщили» ставит
 * markNotified — только после того, как сообщение действительно ушло: потерянное сообщение
 * (Telegram недоступен вместе с Uzum) повторится на следующем сбое, а не через 6 часов.
 */
export function recordFailure(streak: FailureStreak, now: number, policy: FailureAlertPolicy = FAILURE_ALERT_DEFAULTS): { streak: FailureStreak; notify: boolean } {
  const failures = streak.failures + 1;
  const since = streak.since ?? now;
  const due = failures >= policy.notifyAfter && (streak.notifiedAt === null || now - streak.notifiedAt >= policy.repeatMs);
  return { streak: { failures, since, notifiedAt: streak.notifiedAt }, notify: due };
}

export function markNotified(streak: FailureStreak, now: number): FailureStreak {
  return { ...streak, notifiedAt: now };
}

/** Успешный запуск: сброс серии; recovered — о сбое сообщали, пора сказать, что всё снова работает. */
export function recordSuccess(streak: FailureStreak, now: number): { streak: FailureStreak; recovered: boolean; failedForMs: number | null } {
  const recovered = streak.notifiedAt !== null;
  return { streak: emptyStreak(), recovered, failedForMs: recovered && streak.since !== null ? now - streak.since : null };
}

/** «2 ч 15 мин», «40 мин» — сколько длился сбой. */
export function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} мин`;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/** 1 запуск, 2 запуска, 5 запусков. */
export function runsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'запуск' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'запуска' : 'запусков';
  return `${count} ${word}`;
}

/** Текст сообщения о сбое: сколько запусков подряд не прошло и с какого времени. */
export function failureText(title: string, message: string, streak: FailureStreak, now: number): string {
  const lasting = streak.since !== null && streak.failures > 1 ? ` (${runsLabel(streak.failures)} подряд, ${durationLabel(now - streak.since)})` : '';
  return `⚠️ ${title}: запуск не выполнен${lasting} — ${message}`;
}

export function recoveryText(title: string, failedForMs: number | null): string {
  return `✅ ${title}: снова работает${failedForMs !== null ? ` — сбой длился ${durationLabel(failedForMs)}` : ''}`;
}
