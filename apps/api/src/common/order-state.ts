export type CanonicalOrderState = 'RETURNED' | 'CANCELED' | 'PAID' | 'WAITING' | 'OTHER';

export type OrderStateInput = {
  status?: unknown;
  state?: unknown;
  dateIssued?: unknown;
  paidAt?: unknown;
  cancelled?: unknown;
  amount?: unknown;
  amountReturns?: unknown;
};

const CANONICAL = new Set<CanonicalOrderState>(['RETURNED', 'CANCELED', 'PAID', 'WAITING', 'OTHER']);

export function normalizeStatus(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function positiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasDate(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === 0) return false;
  const parsed = value instanceof Date ? value : new Date(value as string | number);
  return !Number.isNaN(parsed.getTime());
}

export function classifyOrderState(input: OrderStateInput): CanonicalOrderState {
  const status = normalizeStatus(input.status);
  const state = normalizeStatus(input.state);
  const combined = `${status} ${state}`;

  if (combined.includes('RETURN') || combined.includes('REFUND')) return 'RETURNED';
  if (combined.includes('CANCEL') || input.cancelled === true) return 'CANCELED';

  const amount = positiveNumber(input.amount);
  const returns = positiveNumber(input.amountReturns);
  if (returns > 0 && (!amount || returns >= amount)) return 'RETURNED';

  const explicitPaid = ['PAID', 'SOLD', 'ISSUED', 'DELIVERED', 'COMPLETED', 'DONE'].some(
    (value) => status === value || state === value,
  );
  if (explicitPaid || hasDate(input.paidAt) || hasDate(input.dateIssued)) return 'PAID';

  const explicitWaiting = ['WAITING', 'PENDING', 'NEW', 'PROCESSING', 'CREATED', 'ASSEMBLING'].some(
    (value) => status === value || state === value,
  );
  if (explicitWaiting) return 'WAITING';

  return 'OTHER';
}

/**
 * Stored orders use explicit canonical state saved by the sync worker. Legacy rows
 * fall back to raw status + paid/issued signal only when there is no canonical state.
 */
export function classifyStoredOrder(input: Omit<OrderStateInput, 'dateIssued'>): CanonicalOrderState {
  const state = normalizeStatus(input.state) as CanonicalOrderState;
  if (CANONICAL.has(state)) return state;
  return classifyOrderState({ ...input, dateIssued: undefined });
}

export function resolveOrderReportDate(
  issuedAt: Date | null,
  orderedAt: Date | null,
  existingDate: Date | null | undefined,
  now = new Date(),
): Date {
  return issuedAt ?? orderedAt ?? existingDate ?? now;
}
