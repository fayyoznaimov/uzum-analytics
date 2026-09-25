import { describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  SupplyType: { FBO: 'FBO', FBS: 'FBS' },
  IntegrationType: { UZUM: 'UZUM' },
  Prisma: {},
}));

import { SuppliesService } from '../supplies.service';

const SupplyType = { FBO: 'FBO', FBS: 'FBS' } as const;

function createService(existing: any) {
  const supply = { id: 's1', shopId: 'shop', type: SupplyType.FBO, externalId: '100', status: 'ACCEPTED' };
  const prisma: any = {
    supply: {
      findUnique: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn().mockResolvedValue(supply),
    },
    supplyStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'h1' }) },
  };
  const integrations: any = { notifyTelegram: vi.fn().mockResolvedValue(true) };
  return { service: new SuppliesService(prisma, integrations), prisma, integrations };
}

describe('supply status notifications', () => {
  it('saves history and sends Telegram notification on a real status change', async () => {
    const { service, prisma, integrations } = createService({ id: 's1', status: 'CREATED', statusLabel: 'Создана' });
    const result = await (service as any).upsertSupply('shop', SupplyType.FBO, {
      id: '100', status: { code: 'ACCEPTED', title: 'Принята' }, warehouseName: 'Сергели', units: 10,
    });
    expect(result.changed).toBe(true);
    expect(prisma.supplyStatusHistory.create).toHaveBeenCalledOnce();
    expect(integrations.notifyTelegram).toHaveBeenCalledWith(expect.stringContaining('Создана → Принята'), 'notifySupplyStatus');
  });

  it('does not notify on initial import or unchanged status', async () => {
    const initial = createService(null);
    await (initial.service as any).upsertSupply('shop', SupplyType.FBO, { id: '100', status: 'CREATED' });
    expect(initial.prisma.supplyStatusHistory.create).toHaveBeenCalledOnce();
    expect(initial.integrations.notifyTelegram).not.toHaveBeenCalled();

    const unchanged = createService({ id: 's1', status: 'ACCEPTED', statusLabel: 'Принята' });
    await (unchanged.service as any).upsertSupply('shop', SupplyType.FBO, { id: '100', status: 'ACCEPTED' });
    expect(unchanged.prisma.supplyStatusHistory.create).not.toHaveBeenCalled();
    expect(unchanged.integrations.notifyTelegram).not.toHaveBeenCalled();
  });
});

describe('safe supply synchronization', () => {
  it('rejects an unrecognized invoices payload instead of treating it as an empty success', async () => {
    const service = new SuppliesService({} as any, {} as any);
    vi.spyOn(service as any, 'request').mockResolvedValue({ unexpected: true });

    await expect((service as any).syncFbo('shop', '92776', 'token'))
      .rejects.toThrow('unexpected payload');
  });

  it('uses the required FBS statuses, the documented page size, and no unsupported shopId', async () => {
    const service = new SuppliesService({} as any, {} as any);
    const request = vi.spyOn(service as any, 'request').mockResolvedValue({ payload: [] });

    await expect((service as any).syncFbs('shop', '92776', 'token')).resolves.toBe(0);
    expect(request).toHaveBeenCalledWith('/v1/fbs/invoice', 'token', {
      page: 0,
      size: 20,
      statuses: ['CREATED', 'ACCEPTANCE_IN_PROGRESS', 'CANCELLED', 'ACCEPTED'],
    });
  });

  it('marks the run as ERROR when either supply source fails', async () => {
    const prisma: any = {
      shop: { findFirst: vi.fn().mockResolvedValue({ id: 'shop', externalId: '92776' }) },
      syncRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'run' }),
        update: vi.fn().mockResolvedValue({ id: 'run' }),
      },
    };
    const integrations: any = {
      getPlain: vi.fn().mockResolvedValue({ token: 'token' }),
      notifyTelegram: vi.fn().mockResolvedValue(false),
    };
    const service = new SuppliesService(prisma, integrations);
    vi.spyOn(service as any, 'syncFbo').mockRejectedValue(new Error('invalid FBO response'));
    vi.spyOn(service as any, 'syncFbs').mockResolvedValue(0);
    const autoFill = vi.spyOn(service as any, 'autoFillLogisticsCosts').mockResolvedValue(0);

    await expect(service.sync()).rejects.toThrow('invalid FBO response');
    expect(autoFill).not.toHaveBeenCalled();
    expect(prisma.syncRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ERROR' }),
    }));
  });

  it('does not repeat the same consecutive supply error in Telegram', async () => {
    const repeatedMessage = 'FBS: /v1/fbs/invoice: HTTP 403 — fbs-2-seller-access-denied';
    const prisma: any = {
      shop: { findFirst: vi.fn().mockResolvedValue({ id: 'shop', externalId: '92776' }) },
      syncRun: {
        findFirst: vi.fn().mockResolvedValue({ status: 'ERROR', message: repeatedMessage }),
        create: vi.fn().mockResolvedValue({ id: 'run' }),
        update: vi.fn().mockResolvedValue({ id: 'run' }),
      },
    };
    const integrations: any = {
      getPlain: vi.fn().mockResolvedValue({ token: 'token' }),
      notifyTelegram: vi.fn().mockResolvedValue(true),
    };
    const service = new SuppliesService(prisma, integrations);
    vi.spyOn(service as any, 'syncFbo').mockResolvedValue(0);
    vi.spyOn(service as any, 'syncFbs').mockRejectedValue(new Error('/v1/fbs/invoice: HTTP 403 — fbs-2-seller-access-denied'));

    await expect(service.sync()).rejects.toThrow('fbs-2-seller-access-denied');
    expect(integrations.notifyTelegram).not.toHaveBeenCalled();
  });

  it('preserves stored supply items when the products endpoint is empty', async () => {
    const transaction = vi.fn();
    const prisma: any = {
      supply: {
        findUnique: vi.fn().mockResolvedValue({
          id: 's1', shopId: 'shop', type: SupplyType.FBO, externalId: '100',
          shop: { externalId: '92776' },
        }),
      },
      $transaction: transaction,
    };
    const integrations: any = { getPlain: vi.fn().mockResolvedValue({ token: 'token' }) };
    const service = new SuppliesService(prisma, integrations);
    vi.spyOn(service as any, 'request').mockResolvedValue({ products: [] });

    await expect((service as any).syncFboItems('s1')).rejects.toThrow('existing items were preserved');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('uses only a uniquely matched marketplace logistics expense and adds no fixed surcharge', async () => {
    const acceptedAt = new Date('2026-08-19T10:00:00.000Z');
    const prisma: any = {
      supply: {
        findMany: vi.fn().mockResolvedValue([
          { id: 's1', raw: { dateAccepted: acceptedAt.toISOString() }, logisticsCost: 0 },
        ]),
        update: vi.fn().mockResolvedValue({ id: 's1' }),
      },
      marketplaceExpense: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'expense', amount: 25_000, serviceAt: acceptedAt },
        ]),
      },
    };
    const service = new SuppliesService(prisma, {} as any);
    vi.spyOn(service as any, 'syncFboItems').mockResolvedValue(undefined);
    const applyAllocated = vi.spyOn(service as any, 'applyAllocatedLogisticsCosts').mockResolvedValue(undefined);

    await expect((service as any).autoFillLogisticsCosts('shop')).resolves.toBe(1);
    expect(prisma.supply.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { logisticsCost: 25_000 },
    });
    expect(applyAllocated).toHaveBeenCalledWith('shop');
  });

  it('does not invent logistics when no marketplace expense can be matched', async () => {
    const prisma: any = {
      supply: {
        findMany: vi.fn().mockResolvedValue([
          { id: 's1', raw: { dateAccepted: '2026-08-19T10:00:00.000Z' }, logisticsCost: 0 },
        ]),
        update: vi.fn(),
      },
      marketplaceExpense: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new SuppliesService(prisma, {} as any);
    const syncItems = vi.spyOn(service as any, 'syncFboItems').mockResolvedValue(undefined);

    await expect((service as any).autoFillLogisticsCosts('shop')).resolves.toBe(0);
    expect(syncItems).not.toHaveBeenCalled();
    expect(prisma.supply.update).not.toHaveBeenCalled();
  });
});
