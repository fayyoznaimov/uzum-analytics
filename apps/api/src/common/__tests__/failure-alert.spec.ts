import { describe, expect, it } from 'vitest';
import { durationLabel, emptyStreak, failureText, markNotified, recordFailure, recordSuccess, recoveryText, runsLabel } from '../failure-alert';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('failure-alert', () => {
  it('разовый сбой не шлёт сообщение, второй подряд — шлёт', () => {
    const first = recordFailure(emptyStreak(), 0);
    expect(first.notify).toBe(false);
    expect(first.streak).toEqual({ failures: 1, since: 0, notifiedAt: null });
    const second = recordFailure(first.streak, 30 * MIN);
    expect(second.notify).toBe(true);
    expect(second.streak).toEqual({ failures: 2, since: 0, notifiedAt: null });
    expect(markNotified(second.streak, 30 * MIN)).toEqual({ failures: 2, since: 0, notifiedAt: 30 * MIN });
  });

  it('сообщение не ушло — пробуем снова на следующем сбое, «снова работает» не шлём', () => {
    const second = recordFailure(recordFailure(emptyStreak(), 0).streak, HOUR);
    expect(second.notify).toBe(true);
    // отправка не удалась — markNotified не вызываем
    const third = recordFailure(second.streak, 2 * HOUR);
    expect(third.notify).toBe(true);
    expect(recordSuccess(third.streak, 3 * HOUR).recovered).toBe(false);
  });

  it('успех после разового сбоя сбрасывает серию молча', () => {
    const first = recordFailure(emptyStreak(), 0);
    const ok = recordSuccess(first.streak, HOUR);
    expect(ok).toEqual({ streak: emptyStreak(), recovered: false, failedForMs: null });
    expect(recordFailure(ok.streak, 2 * HOUR).notify).toBe(false);
  });

  it('пока сбой длится — напоминание не чаще раза в 6 часов, потом «снова работает»', () => {
    let streak = emptyStreak();
    const sent: number[] = [];
    for (let hour = 0; hour <= 13; hour++) {
      const result = recordFailure(streak, hour * HOUR);
      streak = result.notify ? markNotified(result.streak, hour * HOUR) : result.streak;
      if (result.notify) sent.push(hour);
    }
    expect(sent).toEqual([1, 7, 13]);
    const ok = recordSuccess(streak, 14 * HOUR);
    expect(ok.recovered).toBe(true);
    expect(ok.failedForMs).toBe(14 * HOUR);
  });

  it('политика «сразу»: notifyAfter 1', () => {
    expect(recordFailure(emptyStreak(), 0, { notifyAfter: 1, repeatMs: HOUR }).notify).toBe(true);
  });

  it('тексты сообщений', () => {
    expect(runsLabel(1)).toBe('1 запуск');
    expect(runsLabel(2)).toBe('2 запуска');
    expect(runsLabel(5)).toBe('5 запусков');
    expect(runsLabel(11)).toBe('11 запусков');
    expect(runsLabel(22)).toBe('22 запуска');
    expect(durationLabel(40 * MIN)).toBe('40 мин');
    expect(durationLabel(2 * HOUR)).toBe('2 ч');
    expect(durationLabel(2 * HOUR + 15 * MIN)).toBe('2 ч 15 мин');
    expect(failureText('Лестница ставок', 'HTTP 403', { failures: 3, since: 0, notifiedAt: null }, 2 * HOUR))
      .toBe('⚠️ Лестница ставок: запуск не выполнен (3 запуска подряд, 2 ч) — HTTP 403');
    expect(failureText('Лестница ставок', 'HTTP 403', { failures: 1, since: 0, notifiedAt: null }, 0)).toBe('⚠️ Лестница ставок: запуск не выполнен — HTTP 403');
    expect(recoveryText('Лестница ставок', 3 * HOUR)).toBe('✅ Лестница ставок: снова работает — сбой длился 3 ч');
  });
});
