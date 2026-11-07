import { tashkentKey } from './period';

export type PayoutScheduleType = 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

export type WithdrawalBasketInput = {
  id: string;
  externalId?: string | null;
  marketplaceOrderId?: string | null;
  orderedAt?: Date | null;
  issuedAt?: Date | null;
  dateIssued?: Date | null;
  gross: number;
  payout: number;
  units: number;
  returnedUnits?: number;
  returnAmount?: number;
};

export type WithdrawalBasketStatus = 'HOLD' | 'AVAILABLE' | 'SCHEDULED' | 'DUE_TODAY' | 'NEEDS_RECONCILE';

export type WithdrawalBasketRow = {
  date: string;
  scheduledPayoutDate: string;
  amount: number;
  serviceFee: number;
  bankAmount: number;
  gross: number;
  returnReserve: number;
  orders: number;
  units: number;
  returnedUnits: number;
  orderIds: string[];
  status: WithdrawalBasketStatus;
};

export type BasketDailyRow = Omit<WithdrawalBasketRow, 'orderIds'> & {
  daysUntilBasket: number;
  daysUntilPayout: number;
  basketStatusLabel: string;
};

export type PayoutDailyRow = {
  date: string;
  amount: number;
  serviceFee: number;
  bankAmount: number;
  gross: number;
  returnReserve: number;
  orders: number;
  units: number;
  returnedUnits: number;
  basketFrom: string | null;
  basketTo: string | null;
  basketDays: number;
  status: 'FUTURE' | 'DUE_TODAY' | 'NEEDS_RECONCILE';
};

const DAY_MS = 86_400_000;

export function normalizeHoldDays(value: unknown, fallback = 10): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(90, Math.max(0, Math.trunc(parsed)));
}

export function normalizePayoutSchedule(value: unknown): PayoutScheduleType {
  const schedule = String(value || '').trim().toUpperCase();
  if (schedule === 'DAILY' || schedule === 'WEEKLY' || schedule === 'BIWEEKLY' || schedule === 'MONTHLY') return schedule;
  return 'BIWEEKLY';
}

function dateAtTashkentNoon(date: string): Date {
  return new Date(`${date}T12:00:00+05:00`);
}

function fromYmd(year: number, monthOneBased: number, day: number): string {
  return tashkentKey(new Date(Date.UTC(year, monthOneBased - 1, day, 7, 0, 0)));
}

function addCalendarDays(date: string, days: number): string {
  return tashkentKey(new Date(dateAtTashkentNoon(date).getTime() + days * DAY_MS));
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateAtTashkentNoon(to).getTime() - dateAtTashkentNoon(from).getTime()) / DAY_MS);
}

function addMonths(year: number, monthOneBased: number, add: number) {
  const zero = monthOneBased - 1 + add;
  return { year: year + Math.floor(zero / 12), month: ((zero % 12 + 12) % 12) + 1 };
}

function isWeekend(date: string): boolean {
  const day = dateAtTashkentNoon(date).getUTCDay();
  return day === 0 || day === 6;
}

export function nextBusinessDay(date: string): string {
  let result = date;
  while (isWeekend(result)) result = addCalendarDays(result, 1);
  return result;
}

/**
 * Uzum пишет: деньги по графику выплачиваются за товары, полученные больше 10 дней назад.
 * Поэтому товар, полученный 1-го числа, становится доступным в корзине вывода на 12-е число:
 * 10 полных календарных дней удержания + следующий день.
 */
export function basketEligibleDate(dateIssued: Date, holdDays = 10): string {
  return addCalendarDays(tashkentKey(dateIssued), normalizeHoldDays(holdDays) + 1);
}

/** Дни месяца, в которые Uzum формирует выплату по графику. */
const PAYOUT_DAYS: Record<Exclude<PayoutScheduleType, 'DAILY'>, number[]> = { WEEKLY: [7, 14, 21, 28], BIWEEKLY: [7, 21], MONTHLY: [7] };

function firstPayoutDayOnOrAfter(date: string, schedule: Exclude<PayoutScheduleType, 'DAILY'>): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  for (let add = 0; add < 3; add += 1) {
    const next = addMonths(year, month, add);
    for (const day of PAYOUT_DAYS[schedule]) {
      const candidate = fromYmd(next.year, next.month, day);
      if (candidate >= date) return candidate;
    }
  }
  return date;
}

/**
 * Дата выплаты по графику — первый день графика (7 и 21 для BIWEEKLY), не раньше дня входа
 * в корзину. Сверено с фактом 07.11.2026 (34 682 112): в выплату вошли заказы, выданные
 * 11–27.10, — у выданного 27.10 240 часов истекли 06.11, до начала дня выплаты. Старая таблица
 * «выдано 27-го и позже → 21-е число» уносила такие заказы на две недели позже (2,8 млн).
 * Выходной не сдвигает дату: выплата 07.11.2026 сформирована в субботу.
 */
export function scheduledPayoutDate(dateIssued: Date, scheduleInput: unknown = 'BIWEEKLY', holdDays = 10): string {
  const schedule = normalizePayoutSchedule(scheduleInput);
  const eligible = basketEligibleDate(dateIssued, holdDays);
  if (schedule === 'DAILY') return nextBusinessDay(eligible);
  return firstPayoutDayOnOrAfter(eligible, schedule);
}

/** Предыдущий день выплаты по графику: с него начинаются расходы, которые Uzum вычтет из выплаты `payoutDate`. */
export function previousPayoutDate(payoutDate: string, scheduleInput: unknown = 'BIWEEKLY'): string {
  const schedule = normalizePayoutSchedule(scheduleInput);
  if (schedule === 'DAILY') return addCalendarDays(payoutDate, -1);
  let probe = addCalendarDays(payoutDate, -1);
  for (let i = 0; i < 40; i += 1) {
    if (firstPayoutDayOnOrAfter(probe, schedule) === probe) return probe;
    probe = addCalendarDays(probe, -1);
  }
  return addCalendarDays(payoutDate, -14);
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}


function basketStatusLabel(status: WithdrawalBasketStatus): string {
  if (status === 'HOLD') return 'В удержании';
  if (status === 'AVAILABLE') return 'В корзине вывода';
  if (status === 'DUE_TODAY') return 'По графику сегодня';
  if (status === 'NEEDS_RECONCILE') return 'Нужно сверить';
  return 'По графику';
}

function buildBasketDailyRows(rows: WithdrawalBasketRow[], today: string): BasketDailyRow[] {
  return rows.map(({ orderIds: _orderIds, ...row }) => ({
    ...row,
    daysUntilBasket: daysBetween(today, row.date),
    daysUntilPayout: daysBetween(today, row.scheduledPayoutDate),
    basketStatusLabel: basketStatusLabel(row.status),
  }));
}

function buildPayoutDailyRows(rows: WithdrawalBasketRow[], today: string): PayoutDailyRow[] {
  const grouped = new Map<string, PayoutDailyRow>();
  for (const row of rows) {
    const current = grouped.get(row.scheduledPayoutDate) || {
      date: row.scheduledPayoutDate,
      amount: 0,
      serviceFee: 0,
      bankAmount: 0,
      gross: 0,
      returnReserve: 0,
      orders: 0,
      units: 0,
      returnedUnits: 0,
      basketFrom: null,
      basketTo: null,
      basketDays: 0,
      status: row.scheduledPayoutDate < today ? 'NEEDS_RECONCILE' as const : row.scheduledPayoutDate === today ? 'DUE_TODAY' as const : 'FUTURE' as const,
    };
    current.amount += row.amount;
    current.serviceFee += row.serviceFee;
    current.bankAmount += row.bankAmount;
    current.gross += row.gross;
    current.returnReserve += row.returnReserve;
    current.orders += row.orders;
    current.units += row.units;
    current.returnedUnits += row.returnedUnits;
    current.basketFrom = !current.basketFrom || row.date < current.basketFrom ? row.date : current.basketFrom;
    current.basketTo = !current.basketTo || row.date > current.basketTo ? row.date : current.basketTo;
    grouped.set(row.scheduledPayoutDate, current);
  }
  return [...grouped.values()]
    .map((row) => ({ ...row, basketDays: row.basketFrom && row.basketTo ? daysBetween(row.basketFrom, row.basketTo) + 1 : 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type PayoutExpenseInput = { serviceAt: Date; amount: number };

export type PayoutNetRow = PayoutDailyRow & {
  /** С какого дня считаются расходы, вычитаемые из этой выплаты (предыдущая дата графика). */
  expensesFrom: string;
  /** Расходы из журнала Uzum (реклама, логистика, хранение, штрафы) с expensesFrom по день до выплаты. */
  expensesKnown: number;
  /** Оценка ещё не списанных расходов до дня выплаты: средний расход за 7 полных дней × оставшиеся дни. */
  expensesEstimate: number;
  /** Сколько придёт: заказы − расходы − плата за вывод. */
  netAmount: number;
};

/**
 * Uzum вычитает из выплаты все списания журнала расходов с прошлой выплаты: «Буст в ТОП» и «Буст
 * заказов», логистику, хранение, штрафы. 07.11.2026: заказы 38 070 788 − расходы 21.10–06.11
 * 3 505 609 = 34 565 179 против факта 34 682 112 (−0,3 %). Без вычета прогноз завышен на сумму расходов.
 */
export function applyPayoutDeductions(
  rows: PayoutDailyRow[],
  expenses: PayoutExpenseInput[],
  options: { schedule?: PayoutScheduleType | string; today: string; serviceFeePercent?: number },
): PayoutNetRow[] {
  const schedule = normalizePayoutSchedule(options.schedule ?? 'BIWEEKLY');
  const feePercent = Math.max(0, finiteNumber(options.serviceFeePercent, 0));
  const byDay = new Map<string, number>();
  for (const expense of expenses) {
    const key = tashkentKey(expense.serviceAt);
    byDay.set(key, (byDay.get(key) ?? 0) + finiteNumber(expense.amount));
  }
  const rateFrom = addCalendarDays(options.today, -8);
  let lastWeek = 0;
  for (const [key, amount] of byDay) if (key >= rateFrom && key < addCalendarDays(options.today, -1)) lastWeek += amount;
  const dailyRate = Math.max(0, lastWeek / 7);
  return rows.map((row) => {
    const from = previousPayoutDate(row.date, schedule);
    let known = 0;
    for (const [key, amount] of byDay) if (key >= from && key < row.date) known += amount;
    // Журнал за вчера и сегодня ещё дописывается (реклама публикуется на следующий день),
    // поэтому оценка закрывает дни начиная со вчерашнего, где строк ещё нет.
    let estimate = 0;
    if (row.date > options.today) {
      for (let day = addCalendarDays(options.today, -1); day < row.date; day = addCalendarDays(day, 1)) {
        if (day < from) continue;
        if (!byDay.has(day) || day >= options.today) estimate += dailyRate;
      }
    }
    const beforeFee = row.amount - known - estimate;
    return { ...row, expensesFrom: from, expensesKnown: known, expensesEstimate: estimate, netAmount: beforeFee - Math.max(0, beforeFee) * feePercent / 100 };
  });
}

export function calculateEffectivePayout(order: Pick<WithdrawalBasketInput, 'payout' | 'gross' | 'units' | 'returnedUnits' | 'returnAmount'>) {
  const units = Math.max(1, Math.trunc(finiteNumber(order.units, 1)));
  const returnedUnits = Math.min(units, Math.max(0, Math.trunc(finiteNumber(order.returnedUnits, 0))));
  const payout = Math.max(0, finiteNumber(order.payout));
  const gross = Math.max(0, finiteNumber(order.gross));
  const netUnits = Math.max(0, units - returnedUnits);
  // Finance API payout and the dashboard gross passed here are already net of
  // returns. returnedUnits changes the unit count, but must not prorate money a
  // second time (for example, 41,050 for 2 units / 1 return remains 41,050).
  const effectivePayout = payout;
  const effectiveGross = gross;
  return {
    units,
    returnedUnits,
    netUnits,
    effectivePayout,
    effectiveGross,
    returnReserve: Math.max(0, finiteNumber(order.returnAmount)),
  };
}

export function buildWithdrawalBasket(
  orders: WithdrawalBasketInput[],
  options: { holdDays?: number; schedule?: PayoutScheduleType | string; serviceFeePercent?: number; now?: Date } = {},
) {
  const holdDays = normalizeHoldDays(options.holdDays ?? 10);
  const schedule = normalizePayoutSchedule(options.schedule ?? 'BIWEEKLY');
  const serviceFeePercent = Math.max(0, finiteNumber(options.serviceFeePercent, 0));
  const now = options.now || new Date();
  const today = tashkentKey(now);
  const tomorrow = addCalendarDays(today, 1);
  const end7 = addCalendarDays(today, 6);
  const end30 = addCalendarDays(today, 29);
  const grouped = new Map<string, WithdrawalBasketRow>();
  let notIssuedAmount = 0;
  let notIssuedOrders = 0;
  let holdAmount = 0;

  for (const order of orders) {
    const issuedAt = order.issuedAt || order.dateIssued || null;
    const calc = calculateEffectivePayout(order);
    if (calc.effectivePayout <= 0 && calc.returnReserve <= 0) continue;

    if (!issuedAt) {
      notIssuedAmount += calc.effectivePayout;
      notIssuedOrders += 1;
      continue;
    }

    const eligible = basketEligibleDate(issuedAt, holdDays);
    const scheduled = scheduledPayoutDate(issuedAt, schedule, holdDays);
    const serviceFee = calc.effectivePayout * serviceFeePercent / 100;
    const bankAmount = calc.effectivePayout - serviceFee;
    const current = grouped.get(eligible) || {
      date: eligible,
      scheduledPayoutDate: scheduled,
      amount: 0,
      serviceFee: 0,
      bankAmount: 0,
      gross: 0,
      returnReserve: 0,
      orders: 0,
      units: 0,
      returnedUnits: 0,
      orderIds: [],
      status: 'HOLD' as const,
    };
    current.amount += calc.effectivePayout;
    current.serviceFee += serviceFee;
    current.bankAmount += bankAmount;
    current.gross += calc.effectiveGross;
    current.returnReserve += calc.returnReserve;
    current.orders += 1;
    current.units += calc.netUnits;
    current.returnedUnits += calc.returnedUnits;
    current.orderIds.push(order.marketplaceOrderId || order.externalId || order.id);
    if (scheduled > current.scheduledPayoutDate) current.scheduledPayoutDate = scheduled;
    grouped.set(eligible, current);
    if (eligible > today) holdAmount += calc.effectivePayout;
  }

  const rows = [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const row of rows) {
    if (row.date > today) row.status = 'HOLD';
    else if (row.scheduledPayoutDate < today) row.status = 'NEEDS_RECONCILE';
    else if (row.scheduledPayoutDate === today) row.status = 'DUE_TODAY';
    else if (row.date <= today && row.scheduledPayoutDate > today) row.status = 'AVAILABLE';
    else row.status = 'SCHEDULED';
  }

  const basketDailyRows = buildBasketDailyRows(rows, today);
  const payoutDailyRows = buildPayoutDailyRows(rows, today);

  const sum = (predicate: (row: WithdrawalBasketRow) => boolean, key: keyof Pick<WithdrawalBasketRow, 'amount' | 'bankAmount' | 'serviceFee' | 'returnReserve'> = 'amount') =>
    rows.filter(predicate).reduce((total, row) => total + Number(row[key] || 0), 0);
  const basketTomorrow = sum((row) => row.date === tomorrow);
  const basketNext7 = sum((row) => row.date >= today && row.date <= end7);
  const basketNext30 = sum((row) => row.date >= today && row.date <= end30);

  return {
    holdDays,
    schedule,
    serviceFeePercent,
    generatedAt: now,
    today,
    tomorrow,
    rows,
    basketDailyRows,
    payoutDailyRows,
    summary: {
      notIssuedAmount,
      notIssuedOrders,
      inReturnHold: holdAmount,
      basketToday: sum((row) => row.date === today),
      basketTomorrow,
      basketNext7,
      basketNext30,
      availableToWithdraw: sum((row) => row.date <= today),
      dueToday: sum((row) => row.scheduledPayoutDate === today, 'bankAmount'),
      next7Days: sum((row) => row.scheduledPayoutDate >= today && row.scheduledPayoutDate <= end7, 'bankAmount'),
      next30Days: sum((row) => row.scheduledPayoutDate >= today && row.scheduledPayoutDate <= end30, 'bankAmount'),
      needsReconcile: sum((row) => row.scheduledPayoutDate < today, 'bankAmount'),
      returnReserve: sum(() => true, 'returnReserve'),
      totalEligibleBasket: sum((row) => row.date <= today),
      totalTracked: sum(() => true),
    },
  };
}
