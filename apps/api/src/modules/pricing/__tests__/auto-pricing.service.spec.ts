import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  IntegrationStatus: { CONNECTED: 'CONNECTED', ERROR: 'ERROR' },
  IntegrationType: { UZUM: 'UZUM', UZUM_INTERNAL: 'UZUM_INTERNAL', TELEGRAM: 'TELEGRAM' },
}));

import { AutoPricingService } from '../auto-pricing.service';

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

/** Один маржинальный SKU с потоком (7 выкупов за неделю, до этого почти ничего) и один «не используется». */
function setup(patch: { promoPositions?: any[]; stockError?: boolean; history?: any[]; aiText?: string | Error } = {}) {
  const orders = Array.from({ length: 7 }, (_, index) => ({
    status: 'TO_WITHDRAW', state: 'PAID', paidAt: daysAgo(index + 1), issuedAt: daysAgo(index + 1), returnedUnits: 0,
    payout: 22_500, payoutReported: true, grossRevenue: 30_000,
    items: [{ skuId: 'db-sku-1', quantity: 1, returns: 0, amount: 30_000, marketplaceProductId: null, sku: { product: { externalId: '2880108' } } }],
  }));
  // Заказанные, но не выкупленные — в поток не идут.
  orders.push(...Array.from({ length: 10 }, () => ({
    status: 'CANCELED', state: 'CANCELED', paidAt: null, issuedAt: daysAgo(2), returnedUnits: 0, payout: 0, payoutReported: false, grossRevenue: 30_000,
    items: [{ skuId: 'db-sku-2', quantity: 1, returns: 0, amount: 30_000, marketplaceProductId: null, sku: { product: { externalId: '2880108' } } }],
  })) as any);
  const prisma = {
    shop: { findFirst: vi.fn().mockResolvedValue({ id: 'shop-1', externalId: '92776' }) },
    sku: { findMany: vi.fn().mockResolvedValue([
      { id: 'db-sku-1', externalId: '100', sellerSku: 'FAYYOZ-J471-РОЗОВ-БАННЫЙ', stock: 40, product: { externalId: '2880108', title: 'Полотенце' }, costs: [{ amount: 9_000, packagingCost: 500, additionalCost: 0, warehouseLogisticsCost: 500 }] },
      { id: 'db-sku-2', externalId: '200', sellerSku: 'FAYYOZ-OLD', stock: 3, product: { externalId: '2880108', title: 'Полотенце' }, costs: [{ amount: 3, packagingCost: 0, additionalCost: 0, warehouseLogisticsCost: 0 }] },
    ]) },
    order: { findMany: vi.fn().mockResolvedValue(orders) },
    marketplaceExpense: { findMany: vi.fn().mockResolvedValue([]) },
    priceChange: { findMany: vi.fn().mockResolvedValue(patch.history ?? []) },
    financialSettings: { findUnique: vi.fn().mockResolvedValue({ taxPercent: 1 }) },
  };
  const integrations = { notifyTelegram: vi.fn().mockResolvedValue(true) };
  const pricing = {
    guardSettings: vi.fn().mockReturnValue({ minPrice: null, maxStepPercent: 5 }),
    liveSkus: vi.fn().mockResolvedValue(new Map([
      ['100', { skuExternalId: '100', productExternalId: '2880108', title: 'Полотенце', price: 30_000, blocked: false, archived: false, inPromo: Boolean(patch.promoPositions?.length) }],
      ['200', { skuExternalId: '200', productExternalId: '2880108', title: 'Полотенце', price: 30_000, blocked: false, archived: false, inPromo: false }],
    ])),
    sendPrice: vi.fn().mockResolvedValue({ sent: true, verifiedPrice: 30_600, violations: [] }),
  };
  const promo = {
    promoPrices: vi.fn().mockResolvedValue({ shopExternalId: '92776', positions: patch.promoPositions ?? [] }),
    cabinetStock: patch.stockError
      ? vi.fn().mockRejectedValue(new Error('HTTP 400'))
      : vi.fn().mockResolvedValue({ shopExternalId: '92776', raw: {}, forecasts: [{ skuId: '100', quantity: 40, avgDailySales: 1, turnoverDays: 40, outOfStockDays: null }] }),
    sendPromoPrice: vi.fn(),
  };
  const aiText = patch.aiText ?? '[{"skuId":"100","verdict":"APPROVE","price":null,"comment":"спрос растёт, запас есть"}]';
  const openclaw = { run: aiText instanceof Error ? vi.fn().mockRejectedValue(aiText) : vi.fn().mockResolvedValue({ text: aiText, model: 'claude-sonnet-5', provider: 'claude-cli', usage: null }) };
  const service = new AutoPricingService(prisma as any, integrations as any, pricing as any, promo as any, openclaw as any);
  return { service, prisma, integrations, pricing, promo, openclaw };
}

describe('AutoPricingService', () => {
  afterEach(() => vi.clearAllMocks());

  it('режим рекомендаций: считает поток по выкупам, ничего не отправляет в Uzum, шлёт отчёт в Telegram', async () => {
    const { service, pricing, promo, integrations } = setup();
    const result = await service.run({ apply: false, notify: true });
    expect(result.plan.changes.map((row) => [row.skuId, row.rule, row.newPrice])).toEqual([['100', 'FLOW', 30_600]]);
    expect(result.plan.changes[0].metrics).toMatchObject({ units7: 7, units28: 7 });
    expect(result.plan.skips.map((row) => [row.skuId, row.reason])).toEqual([['200', 'не используется (себестоимость 2–5 сум)']]);
    expect(pricing.sendPrice).not.toHaveBeenCalled();
    expect(promo.sendPromoPrice).not.toHaveBeenCalled();
    expect(integrations.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(integrations.notifyTelegram.mock.calls[0][0]).toContain('только рекомендации');
  });

  it('режим изменения: отправляет через PricingService с source = auto, правилом и контекстом', async () => {
    const { service, pricing } = setup();
    const result = await service.run({ apply: true, notify: false });
    expect(pricing.sendPrice).toHaveBeenCalledTimes(1);
    const [skuId, price, options] = pricing.sendPrice.mock.calls[0];
    expect([skuId, price]).toEqual(['100', 30_600]);
    expect(options).toMatchObject({ dryRun: false, source: 'auto', rule: 'FLOW', maxStepPercent: 5, context: { role: 'MARGINAL', stock: 40, units7: 7 } });
    expect(result.outcomes).toEqual([{ skuId: '100', ok: true, message: 'Uzum показывает 30600' }]);
  });

  it('ИИ отклонил — цена не меняется, причина в отчёте', async () => {
    const { service, pricing } = setup({ aiText: '[{"skuId":"100","verdict":"REJECT","comment":"рост из-за акции конкурента"}]' });
    const result = await service.run({ apply: true, notify: false });
    expect(pricing.sendPrice).not.toHaveBeenCalled();
    expect(result.aiNote).toContain('одобрено 0 из 1');
    expect(result.plan.holds.find((row) => row.skuId === '100')?.reason).toContain('ИИ отклонил: рост из-за акции конкурента');
  });

  it('ИИ недоступен: в режиме изменений ничего не меняем, в режиме рекомендаций — решения правил с пометкой', async () => {
    const applied = setup({ aiText: new Error('OpenClaw не ответил за 330 с') });
    const result = await applied.service.run({ apply: true, notify: false });
    expect(applied.pricing.sendPrice).not.toHaveBeenCalled();
    expect(result.aiNote).toContain('цены в этот запуск не меняются');

    const advised = setup({ aiText: new Error('OpenClaw не ответил за 330 с') });
    const advice = await advised.service.run({ apply: false, notify: false });
    expect(advice.plan.changes).toHaveLength(1);
    expect(advice.messages[0]).toContain('решения только по правилам');
  });

  it('цена в акции на лимите — рекомендация вместо изменения', async () => {
    const { service, pricing, promo } = setup({ promoPositions: [{ saleId: 393, skuId: 100, saleTitle: 'Скидки недели', saleStatus: 'ACTIVE', salePrice: 29_700, maxPrice: 29_700, basePrice: 30_000 }] });
    const result = await service.run({ apply: true, notify: false });
    expect(result.plan.changes).toEqual([]);
    expect(result.plan.recommendations[0].reason).toContain('поднять базовую после акции');
    expect(pricing.sendPrice).not.toHaveBeenCalled();
    expect(promo.sendPromoPrice).not.toHaveBeenCalled();
  });

  it('журнал: изменение сегодня блокирует SKU; сбой запаса из кабинета — заметка в отчёте', async () => {
    const { service } = setup({ stockError: true, history: [{ skuExternalId: '100', createdAt: new Date(), kind: 'BASE', oldPrice: 29_500, newPrice: 30_000, verifiedPrice: 30_000, rule: null, context: null, request: {} }] });
    const result = await service.run({ apply: false, notify: false });
    expect(result.plan.skips.find((row) => row.skuId === '100')?.reason).toBe('цена уже менялась сегодня');
    expect(result.notes[0]).toContain('Запас из кабинета не получен');
    expect(result.messages[0]).toContain('правила дефицита не применялись');
  });
});
