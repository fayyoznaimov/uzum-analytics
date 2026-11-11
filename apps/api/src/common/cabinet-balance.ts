/**
 * «Можно вывести» и общий баланс — по самому кабинету Uzum, а не по нашему пересчёту.
 *
 * Кабинет → Финансы: «К выплате 21 ноября 6 887 440 сум — все накопленные деньги по 10.11.2026» и «Общий баланс».
 * Источник — API кабинета (токен UZUM_INTERNAL):
 *   GET api-seller.uzum.uz/api/v1/seller/finance/payout-schedule?shopIds=…  → nextPayout { amount, date, periodTo, payoutModel }
 *     (нужен заголовок Accept-Language: ru — на «ru-RU» Uzum отвечает 400);
 *   GET api-seller.uzum.uz/api/v1/seller/finance/balance?shopIds=…          → total.
 *
 * Сверка 11.11.2026: корзина кабинета (заказы, ставшие TO_WITHDRAW после выплаты 07.11) совпала с нашей до сума —
 * 7 793 333, а вычеты — нет: «корзина − все списания журнала с выплаты» дал 5 967 521 против 6 887 440 в кабинете.
 * У новых заказов логистика уже вычтена в forWithdraw и ещё раз приходит строкой журнала расходов, и как Uzum
 * сводит их между выплатами, по данным восстановить до сума не удалось. Поэтому сумма берётся у Uzum, а наш расчёт
 * остаётся запасным — с пометкой «расчёт», когда кабинет недоступен (Cloudflare 11.11.2026 закрывал его серверу).
 */

export type CabinetBalance = {
  /** Сколько Uzum выплатит в ближайшую дату графика по уже накопленному — это и есть «можно вывести раньше». */
  nextPayoutAmount: number;
  /** Дата ближайшей выплаты по графику (ГГГГ-ММ-ДД); null — Uzum не назвал (нечего выплачивать). */
  nextPayoutDate: string | null;
  /** «Все накопленные деньги по …» — последний день, за который сумма собрана. */
  periodTo: string | null;
  payoutModel: string | null;
  /** График выплат в кабинете (TWICE_A_MONTH и т.п.). */
  schedule: string | null;
  /** «Общий баланс» кабинета: вместе с деньгами в удержании и в пути. */
  totalBalance: number | null;
};

/** Сервер обновляет снимок каждые 15 минут; старше — кабинет недоступен, на экране уже наш расчёт. */
export const CABINET_BALANCE_MAX_AGE_HOURS = 6;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseCabinetBalance(schedule: unknown, balance: unknown): CabinetBalance {
  const body = schedule && typeof schedule === 'object' ? schedule as Record<string, any> : null;
  if (!body || !('nextPayout' in body || 'current' in body)) throw new Error('finance/payout-schedule: неожиданная форма ответа — нет nextPayout и current');
  const next = body.nextPayout && typeof body.nextPayout === 'object' ? body.nextPayout : null;
  // Пустой nextPayout при узнаваемом ответе — накопленного нет; сумма ноль, а не «не знаем».
  const amount = next ? Number(next.amount) : 0;
  if (!Number.isFinite(amount)) throw new Error('finance/payout-schedule: nextPayout.amount не число');
  const date = next && DAY.test(String(next.date ?? '')) ? String(next.date) : null;
  if (next && !date) throw new Error('finance/payout-schedule: у nextPayout нет даты');
  const total = Number((balance as any)?.total);
  return {
    nextPayoutAmount: amount,
    nextPayoutDate: date,
    periodTo: next && DAY.test(String(next.periodTo ?? '')) ? String(next.periodTo) : null,
    payoutModel: next?.payoutModel ? String(next.payoutModel) : null,
    schedule: body.current?.schedule ? String(body.current.schedule) : null,
    totalBalance: balance && typeof balance === 'object' && Number.isFinite(total) ? total : null,
  };
}

/**
 * Снимок годится, пока он свежий и его выплата ещё не наступила: в день выплаты Uzum забирает накопленное
 * (заявку создаёт около 01:00 по Ташкенту), и вчерашняя сумма «к выплате» уже не про сегодняшний остаток.
 */
export function cabinetBalanceUsable(snapshot: { fetchedAt: Date; nextPayoutDate: string | null } | null | undefined, now: Date, today: string): boolean {
  if (!snapshot) return false;
  const age = now.getTime() - snapshot.fetchedAt.getTime();
  if (!(age >= 0 && age <= CABINET_BALANCE_MAX_AGE_HOURS * 3_600_000)) return false;
  return snapshot.nextPayoutDate === null || snapshot.nextPayoutDate > today;
}
