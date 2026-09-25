import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalsService } from '../goals.service';

type ServiceOptions = {
  syncStartedAt?: Date | null;
  syncFinishedAt?: Date;
  orderDate?: Date;
  grossRevenue?: number;
  payout?: number;
  costs?: Array<{
    validFrom: Date; validTo: Date | null; amount: number;
    packagingCost: number; warehouseLogisticsCost: number; additionalCost: number;
  }>;
};

function serviceFor(metric: string, endAt: Date, advertising: number, options: ServiceOptions = {}) {
  const goal = {
    id: 'goal', shopId: 'shop', metric, targetValue: 100,
    startAt: new Date('2026-01-01T00:00:00+05:00'), endAt,
    period: 'CUSTOM', shop: {},
  };
  const order = {
    id: 'order', externalId: 'order', marketplaceOrderId: 'parent',
    status: 'PAID', state: 'PAID', paidAt: options.orderDate ?? new Date('2026-01-02'), dateIssued: options.orderDate ?? new Date('2026-01-02'),
    grossRevenue: options.grossRevenue ?? 200, payout: options.payout ?? 150, commission: 0, logistics: 0,
    payoutReported: true, commissionReported: true, logisticsReported: true, returnedUnits: 0,
    items: [{ quantity: 1, returns: 0, amount: options.grossRevenue ?? 200, sku: { costs: options.costs ?? [{ validFrom: new Date('2025-01-01'), validTo: null, amount: 20, packagingCost: 0, warehouseLogisticsCost: 0, additionalCost: 0 }] } }],
  };
  const syncStartedAt = options.syncStartedAt === undefined
    ? new Date('2026-08-19T10:00:00+05:00')
    : options.syncStartedAt;
  const prisma = {
    goal: { findMany: vi.fn().mockResolvedValue([goal]) },
    order: { findMany: vi.fn().mockResolvedValueOnce([order]).mockResolvedValueOnce([order]) },
    financialSettings: { upsert: vi.fn().mockResolvedValue({ taxPercent: 0, marketplaceCommissionFallbackPercent: 0 }) },
    marketplaceExpense: { findMany: vi.fn().mockResolvedValue(advertising ? [{ amount: advertising }] : []) },
    syncRun: { findFirst: vi.fn().mockResolvedValue(syncStartedAt ? {
      startedAt: syncStartedAt,
      finishedAt: options.syncFinishedAt ?? new Date(syncStartedAt.getTime() + 60_000),
    } : null) },
  } as any;
  return new GoalsService(prisma, {} as any);
}

describe('GoalsService financial completeness', () => {
  afterEach(() => vi.useRealTimers());

  it('does not mark a live PROFIT goal complete before advertising is final', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00+05:00'));
    const [goal] = await serviceFor('PROFIT', new Date('2026-08-19T23:59:59+05:00'), 0).list();

    expect(goal.current).toBe(130);
    expect(goal.metricKnown).toBe(false);
    expect(goal.progress).toBeNull();
  });

  it('returns unknown rather than zero ROAS for a non-positive signed advertising denominator', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00+05:00'));
    const [goal] = await serviceFor('ROAS', new Date('2026-01-31T23:59:59+05:00'), -20).list();

    expect(goal.current).toBeNull();
    expect(goal.metricKnown).toBe(false);
    expect(goal.progress).toBeNull();
  });

  it('does not finalize historical PROFIT from date age alone without a successful full sync', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00+05:00'));
    const [goal] = await serviceFor(
      'PROFIT',
      new Date('2026-01-31T23:59:59+05:00'),
      0,
      { syncStartedAt: null },
    ).list();

    expect(goal.current).toBe(130);
    expect(goal.inputCoverage.advertisingFinal).toBe(false);
    expect(goal.inputCoverage.expenseSyncWatermark).toBeNull();
    expect(goal.metricKnown).toBe(false);
    expect(goal.progress).toBeNull();
  });

  it('keeps REVENUE known when no financial-expense watermark exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00+05:00'));
    const [goal] = await serviceFor(
      'REVENUE',
      new Date('2026-01-31T23:59:59+05:00'),
      0,
      { syncStartedAt: null },
    ).list();

    expect(goal.current).toBe(200);
    expect(goal.metricKnown).toBe(true);
    expect(goal.progress).toBe(100);
  });

  it('backfills the corrected active cost instead of the sale-date placeholder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00+05:00'));
    const [goal] = await serviceFor(
      'PROFIT',
      new Date('2026-08-17T23:59:59+05:00'),
      0,
      {
        orderDate: new Date('2026-08-17T11:30:29.344+05:00'),
        grossRevenue: 100_000,
        payout: 100_000,
        syncStartedAt: new Date('2026-08-19T10:00:00+05:00'),
        costs: [
          { validFrom: new Date('2026-08-18T00:00:00+05:00'), validTo: null, amount: 72_000, packagingCost: 0, warehouseLogisticsCost: 1_240.2, additionalCost: 0 },
          { validFrom: new Date('2025-01-01T00:00:00+05:00'), validTo: new Date('2026-08-18T00:00:00+05:00'), amount: 0, packagingCost: 0, warehouseLogisticsCost: 1_240.2, additionalCost: 0 },
        ],
      },
    ).list();

    expect(goal.current).toBeCloseTo(26_759.8, 5);
    expect(goal.inputCoverage.costsKnown).toBe(true);
    expect(goal.inputCoverage.advertisingFinal).toBe(true);
    expect(goal.metricKnown).toBe(true);
  });

  it('does not treat an expired historical placeholder as a known cost', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00+05:00'));
    const [goal] = await serviceFor(
      'PROFIT',
      new Date('2026-01-31T23:59:59+05:00'),
      0,
      {
        costs: [{ validFrom: new Date('2025-01-01'), validTo: new Date('2026-01-15'), amount: 0, packagingCost: 0, warehouseLogisticsCost: 1_240.2, additionalCost: 0 }],
      },
    ).list();

    expect(goal.inputCoverage.costsKnown).toBe(false);
    expect(goal.metricKnown).toBe(false);
    expect(goal.progress).toBeNull();
  });

  it('does not notify for a financial goal without a verified expense watermark', async () => {
    const notifyTelegram = vi.fn();
    const prisma = {
      notificationLog: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    } as any;
    const service = new GoalsService(prisma, { notifyTelegram } as any);
    vi.spyOn(service, 'list').mockResolvedValue([{
      id: 'goal-without-watermark',
      metric: 'PROFIT',
      metricKnown: false,
      progress: null,
      startAt: new Date('2026-01-01T00:00:00+05:00'),
    }] as any);

    await service.notifyCompletedGoals();

    expect(notifyTelegram).not.toHaveBeenCalled();
    expect(prisma.notificationLog.findUnique).not.toHaveBeenCalled();
    expect(prisma.notificationLog.create).not.toHaveBeenCalled();
  });
});
