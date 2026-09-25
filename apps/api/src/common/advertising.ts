export type AdvertisingExpenseLike = {
  id?: string | null;
  productExternalId?: string | null;
  serviceAt?: Date | string | null;
  createdAt?: Date | string | null;
  name?: string | null;
  raw?: unknown;
};

export type ProductAdvertisingRate = {
  productExternalId: string;
  percent: number;
  observedAt: Date;
  createdAt?: Date;
  id?: string;
};

export type ProductAdvertisingRateTimeline = Map<string, ProductAdvertisingRate[]>;

export const ORDER_BOOST_CODE = 'У000120';
export const TOP_PROMOTION_CODE = 'У000119';
export const ADVERTISING_EXPENSE_CODES = [
  ORDER_BOOST_CODE,
  TOP_PROMOTION_CODE,
  `return-${ORDER_BOOST_CODE}`,
  `return-${TOP_PROMOTION_CODE}`,
] as const;

export function baseAdvertisingCode(code: unknown): string {
  return String(code ?? '').replace(/^return-/u, '');
}

function finitePercent(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    value = value.replace(',', '.').trim();
    if (!value) return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function objectPercent(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  for (const key of [
    'promotionPercent',
    'advertisingPercent',
    'salePercent',
    'boostPercent',
    'percent',
  ]) {
    const value = finitePercent(source[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Uzum currently embeds the Boost-orders rate in the expense description.
 * Both Russian and Uzbek descriptions exist in exports/API responses, for
 * example "Процент за продажу — 5%" and "Sotuvdan foiz — 6%".
 */
export function parseAdvertisingPercent(name: unknown, raw?: unknown): number | null {
  const explicit = objectPercent(raw);
  if (explicit !== null) return explicit;

  const text = String(name ?? '').normalize('NFKC');
  const labelled = text.match(
    /(?:процент\s+за\s+продажу|sotuv(?:dan)?\s+foiz(?:i)?|сотув(?:дан)?\s+фоиз(?:и)?)[^\d]{0,24}(\d+(?:[.,]\d+)?)\s*%/iu,
  )?.[1];
  if (labelled !== undefined) return finitePercent(labelled);

  // Expense У000120 contains a single percentage. Keep this fallback here so
  // harmless wording changes by Uzum do not silently turn a known rate into 0.
  const onlyPercent = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/gu)];
  return onlyPercent.length === 1 ? finitePercent(onlyPercent[0][1]) : null;
}

function validDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const isoDate = trimmed.match(/^(\d{4})[-./](\d{2})[-./](\d{2})$/u);
    if (isoDate) return new Date(`${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00+05:00`);
    const localDate = trimmed.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/u);
    if (localDate) return new Date(`${localDate[3]}-${localDate[2]}-${localDate[1]}T00:00:00+05:00`);
  }
  const numeric = Number(value);
  const parsed = value instanceof Date
    ? value
    : Number.isFinite(numeric) && numeric > 0
      ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
      : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function rawAdvertisingEffectiveAt(raw: unknown): Date | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  for (const key of [
    'promotionDate',
    'displayDate',
    'showDate',
    'shownAt',
    'advertisingDate',
    'orderDate',
    'dateDisplay',
    'dateShown',
  ]) {
    const parsed = validDate(source[key]);
    if (parsed) return parsed;
  }
  return null;
}

/** Date when the advertised order was shown, not the later ledger debit date. */
export function parseAdvertisingEffectiveAt(name: unknown, raw?: unknown): Date | null {
  const explicit = rawAdvertisingEffectiveAt(raw);
  if (explicit) return explicit;
  const text = String(name ?? '').normalize('NFKC');
  const token = text.match(
    /(?:namoyish|намойиш|показ(?:\s+рекламы)?|дата\s+показа)[^\d]{0,32}(\d{4}[-./]\d{2}[-./]\d{2}|\d{2}[./-]\d{2}[./-]\d{4})/iu,
  )?.[1];
  return token ? validDate(token) : null;
}

function rateFromExpense(expense: AdvertisingExpenseLike): ProductAdvertisingRate | null {
  const productExternalId = String(expense.productExternalId ?? '').trim();
  // serviceAt is the day Uzum debited the seller after fulfilment. The rate
  // belongs to the original display/order day embedded as "Namoyish"/"Показ".
  const observedAt = parseAdvertisingEffectiveAt(expense.name, expense.raw)
    ?? validDate(expense.serviceAt);
  const percent = parseAdvertisingPercent(expense.name, expense.raw);
  if (!productExternalId || !observedAt || percent === null) return null;

  const createdAt = validDate(expense.createdAt);
  const id = String(expense.id ?? '').trim();
  return {
    productExternalId,
    percent,
    observedAt,
    ...(createdAt ? { createdAt } : {}),
    ...(id ? { id } : {}),
  };
}

function compareAdvertisingRates(a: ProductAdvertisingRate, b: ProductAdvertisingRate): number {
  const observedAt = a.observedAt.getTime() - b.observedAt.getTime();
  if (observedAt !== 0) return observedAt;

  const aCreatedAt = a.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bCreatedAt = b.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aCreatedAt !== bCreatedAt) return aCreatedAt < bCreatedAt ? -1 : 1;

  const aId = a.id ?? '';
  const bId = b.id ?? '';
  if (aId !== bId) return aId < bId ? -1 : 1;

  // Legacy callers may not provide createdAt/id. Percent is a stable final
  // tie-breaker so the result still does not depend on database row order.
  return a.percent - b.percent;
}

export function latestAdvertisingRates(
  expenses: AdvertisingExpenseLike[],
  options: { now?: Date; lookbackDays?: number } = {},
): Map<string, ProductAdvertisingRate> {
  const now = options.now ?? new Date();
  const lookbackDays = Math.max(0, Number(options.lookbackDays ?? 30));
  const cutoff = new Date(now.getTime() - lookbackDays * 86_400_000);
  const rates = new Map<string, ProductAdvertisingRate>();

  for (const expense of expenses) {
    const candidate = rateFromExpense(expense);
    if (!candidate || candidate.observedAt < cutoff || candidate.observedAt > now) continue;
    const current = rates.get(candidate.productExternalId);
    if (!current || compareAdvertisingRates(candidate, current) > 0) {
      rates.set(candidate.productExternalId, candidate);
    }
  }
  return rates;
}

export function advertisingRateTimeline(expenses: AdvertisingExpenseLike[]): ProductAdvertisingRateTimeline {
  const timeline: ProductAdvertisingRateTimeline = new Map();
  for (const expense of expenses) {
    const candidate = rateFromExpense(expense);
    if (!candidate) continue;
    const rows = timeline.get(candidate.productExternalId) ?? [];
    rows.push(candidate);
    timeline.set(candidate.productExternalId, rows);
  }
  for (const rows of timeline.values()) rows.sort(compareAdvertisingRates);
  return timeline;
}

export function advertisingRateAt(
  timeline: ProductAdvertisingRateTimeline,
  productExternalId: string | null | undefined,
  at: Date,
  options: { maxAgeDays?: number } = {},
): ProductAdvertisingRate | null {
  const rows = timeline.get(String(productExternalId ?? '').trim()) ?? [];
  let result: ProductAdvertisingRate | null = null;
  for (const row of rows) {
    if (row.observedAt > at) break;
    result = row;
  }
  if (!result) return null;
  const maxAgeDays = Math.max(0, Number(options.maxAgeDays ?? 30));
  return at.getTime() - result.observedAt.getTime() <= maxAgeDays * 86_400_000 ? result : null;
}

export function advertisingEstimate(
  items: Array<{ amount: unknown; productExternalId?: string | null }>,
  rates: Map<string, ProductAdvertisingRate>,
): { amount: number; effectivePercent: number; coveredRevenue: number; totalRevenue: number } {
  let amount = 0;
  let coveredRevenue = 0;
  let totalRevenue = 0;
  for (const item of items) {
    const revenue = Math.max(0, Number(item.amount) || 0);
    totalRevenue += revenue;
    const rate = rates.get(String(item.productExternalId ?? '').trim());
    if (!rate) continue;
    coveredRevenue += revenue;
    amount += revenue * rate.percent / 100;
  }
  return {
    amount,
    effectivePercent: totalRevenue > 0 ? amount / totalRevenue * 100 : 0,
    coveredRevenue,
    totalRevenue,
  };
}

export function advertisingEstimateAt(
  items: Array<{ amount: unknown; productExternalId?: string | null }>,
  timeline: ProductAdvertisingRateTimeline,
  at: Date,
  options: { maxRateAgeDays?: number } = {},
): { amount: number; effectivePercent: number; coveredRevenue: number; totalRevenue: number } {
  let amount = 0;
  let coveredRevenue = 0;
  let totalRevenue = 0;
  for (const item of items) {
    const revenue = Math.max(0, Number(item.amount) || 0);
    totalRevenue += revenue;
    const rate = advertisingRateAt(timeline, item.productExternalId, at, { maxAgeDays: options.maxRateAgeDays });
    if (!rate) continue;
    coveredRevenue += revenue;
    amount += revenue * rate.percent / 100;
  }
  return {
    amount,
    effectivePercent: totalRevenue > 0 ? amount / totalRevenue * 100 : 0,
    coveredRevenue,
    totalRevenue,
  };
}
