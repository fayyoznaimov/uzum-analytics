import { tashkentKey } from './period';

export type PayoutForecastInput = {
  id: string;
  externalId?: string | null;
  marketplaceOrderId?: string | null;
  paidAt?: Date | null;
  orderedAt?: Date | null;
  dateIssued: Date;
  payout: number;
  units: number;
};

export type PayoutForecastDay = {
  date: string;
  amount: number;
  orders: number;
  units: number;
  orderIds: string[];
};

const DAY_MS = 86_400_000;

export function normalizePayoutDelayDays(value: unknown, fallback = 10): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(90, Math.max(0, Math.trunc(parsed)));
}

export function expectedPayoutAt(order: Pick<PayoutForecastInput, 'dateIssued'>, delayDays = 10): Date {
  // Deprecated compatibility helper. For Uzum cash flow use payout-basket.ts.
  // Do not use orderedAt/paidAt: money becomes eligible only after factual issue dateIssued.
  return new Date(order.dateIssued.getTime() + (normalizePayoutDelayDays(delayDays) + 1) * DAY_MS);
}

function dateAtTashkentNoon(date: string): Date {
  return new Date(`${date}T12:00:00+05:00`);
}

function addCalendarDays(date: string, days: number): string {
  return tashkentKey(new Date(dateAtTashkentNoon(date).getTime() + days * DAY_MS));
}

export function buildPayoutForecast(
  orders: PayoutForecastInput[],
  delayDays = 10,
  now = new Date(),
): {
  delayDays: number;
  generatedAt: Date;
  today: string;
  tomorrow: string;
  rows: PayoutForecastDay[];
  summary: {
    overdue: number;
    dueToday: number;
    dueTomorrow: number;
    next7Days: number;
    next30Days: number;
    upcoming: number;
    totalTracked: number;
  };
} {
  const safeDelay = normalizePayoutDelayDays(delayDays);
  const today = tashkentKey(now);
  const tomorrow = addCalendarDays(today, 1);
  const end7 = addCalendarDays(today, 6);
  const end30 = addCalendarDays(today, 29);
  const grouped = new Map<string, PayoutForecastDay>();

  for (const order of orders) {
    const payout = Number(order.payout || 0);
    if (!Number.isFinite(payout) || payout <= 0) continue;
    const date = tashkentKey(expectedPayoutAt(order, safeDelay));
    const row = grouped.get(date) || { date, amount: 0, orders: 0, units: 0, orderIds: [] };
    row.amount += payout;
    row.orders += 1;
    row.units += Math.max(0, Math.trunc(Number(order.units || 0)));
    row.orderIds.push(order.marketplaceOrderId || order.externalId || order.id);
    grouped.set(date, row);
  }

  const rows = [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sum = (predicate: (row: PayoutForecastDay) => boolean) => rows.filter(predicate).reduce((total, row) => total + row.amount, 0);

  return {
    delayDays: safeDelay,
    generatedAt: now,
    today,
    tomorrow,
    rows,
    summary: {
      overdue: sum((row) => row.date < today),
      dueToday: sum((row) => row.date === today),
      dueTomorrow: sum((row) => row.date === tomorrow),
      next7Days: sum((row) => row.date >= today && row.date <= end7),
      next30Days: sum((row) => row.date >= today && row.date <= end30),
      upcoming: sum((row) => row.date >= today),
      totalTracked: sum(() => true),
    },
  };
}
