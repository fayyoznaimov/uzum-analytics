import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  IntegrationStatus: { CONNECTED: 'CONNECTED', ERROR: 'ERROR' },
  IntegrationType: { UZUM: 'UZUM', UZUM_INTERNAL: 'UZUM_INTERNAL', TELEGRAM: 'TELEGRAM' },
}));

import { IntegrationsService } from '../integrations.service';

function createService() {
  return new IntegrationsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
}

function createReportService(dashboardData: any, costRows: any[] = []) {
  const telegram = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
  const dashboard = { overview: vi.fn().mockResolvedValue(dashboardData) };
  const costs = { list: vi.fn().mockResolvedValue(costRows) };
  return {
    service: new IntegrationsService({} as any, {} as any, telegram as any, {} as any, dashboard as any, costs as any, {} as any),
    telegram,
  };
}

describe('Uzum internal integration check', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a Bearer token only when the returned review belongs to the requested shop', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ payload: [{ reviewId: 1, shop: { id: 92776 } }], timestamp: 123 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = createService();

    const result = await (service as any).uzumInternalReviewsRequest('Bearer internal-token', '92776');

    expect(result).toEqual({ rowsAvailable: 1, shopId: '92776', timestamp: 123 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer internal-token');
  });

  it('rejects a token for a different seller shop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ payload: [{ reviewId: 1, shop: { id: 11111 } }] }),
    }));
    const service = createService();

    await expect((service as any).uzumInternalReviewsRequest('internal-token', '92776'))
      .rejects.toThrow('returned shop 11111, expected 92776');
  });
});

describe('Telegram financial reports', () => {
  it('does not turn unknown daily profit into zero', async () => {
    const { service, telegram } = createReportService({
      metrics: {
        orderedUnits: 2,
        orderedRevenue: 200,
        orderedPayout: 150,
        orderedPotentialProfit: null,
        orderedPotentialProfitKnown: false,
        paidUnits: 1,
        revenue: 100,
        payout: 80,
        profit: 999,
        profitKnown: false,
      },
    });

    await (service as any).sendProfitReport('token', 'chat', 'today');

    const message = telegram.sendMessage.mock.calls[0][2];
    expect(message).toContain('Потенциальная прибыль: <b>не рассчитана</b>');
    expect(message).toContain('Чистая прибыль: <b>не рассчитана</b>');
    expect(message).toContain('Чистая маржа: <b>—</b>');
    expect(message).not.toContain('Потенциальная прибыль: <b>0');
    expect(message).not.toContain('999');
  });

  it('reports warehouse profit only for SKUs with known advertising rates', async () => {
    const { service, telegram } = createReportService({}, [
      {
        stock: 2,
        price: 100,
        sellerPayout: 80,
        cost: 30,
        packagingCost: 5,
        warehouseLogisticsCost: 5,
        additionalCost: 0,
        fullCostEstimate: 60,
        marginEstimate: 20,
        marginEstimateKnown: true,
      },
      {
        stock: 3,
        price: 200,
        sellerPayout: 150,
        cost: 40,
        packagingCost: 5,
        warehouseLogisticsCost: 5,
        additionalCost: 0,
        fullCostEstimate: null,
        marginEstimate: null,
        marginEstimateKnown: false,
      },
    ]);

    await (service as any).sendStockReport('token', 'chat');

    const message = telegram.sendMessage.mock.calls[0][2];
    expect(message).toContain('Расходы по известной части: <b>120 сум</b>');
    expect(message).toContain('Прибыль по известной части: <b>40 сум</b>');
    expect(message).toContain('Покрытие расчёта: <b>1 из 2 SKU • 2 из 5 шт.</b>');
    expect(message).toContain('Без расчёта: <b>1 SKU • 3 шт.</b>');
    expect(message).not.toContain('📉 Все расходы:');
  });
});
